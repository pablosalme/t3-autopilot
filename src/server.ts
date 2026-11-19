import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mergeCapabilities, parseCapabilitiesInput, SelectedOptionSchema } from "./capabilities.js";
import {
  type CapabilitiesEntry,
  formatAge,
  loadCapabilitiesCache,
  saveCapabilitiesCache,
} from "./capabilitiesCache.js";
import { computeStats, logDelegation, logOutcome, OUTCOMES, readLog } from "./log.js";
import { autopilotHome, DATA_FILES } from "./paths.js";
import { type LoadedPolicy, loadPolicy, type Policy } from "./policy.js";
import { recommendModel } from "./recommend.js";
import { activeMarks, clearUnavailable, markUnavailable, UNAVAILABLE_DEFAULT_HOURS } from "./unavailable.js";
import { createUsageSource, ProviderUsageSchema, type UsageSource } from "./usage.js";

export const VERSION = "0.1.0";

const NOTHING_TO_MERGE =
  "mergeCapabilities: there were no earlier capabilities to merge into (first call, or the server restarted and " +
  "its saved copy is missing or expired), so only this output was used and it was not kept. If it is a search " +
  "output, pass the full orchestrator_capabilities output too, as capabilities: [full, search].";

const NO_CAPABILITIES =
  "No capabilities yet: call orchestrator_capabilities and pass its full output as `capabilities` (later calls can omit it).";

export interface ServerOptions {
  /** Loads the policy; called on every tool call so edits apply without a restart. */
  loadPolicy?: () => LoadedPolicy;
  usageSource?: UsageSource;
  /**
   * Data directory (log.jsonl, capabilities-cache.json, unavailable.json):
   * $T3_AUTOPILOT_HOME or ~/.t3-autopilot by default.
   */
  dataDir?: () => string;
  /** Log file; `<dataDir>/log.jsonl` by default. */
  logPath?: () => string;
  /** Clock, for tests. */
  now?: () => Date;
}

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const load = opts.loadPolicy ?? (() => loadPolicy());
  const dataDir = opts.dataDir ?? autopilotHome;
  const getLogPath = opts.logPath ?? (() => join(dataDir(), DATA_FILES.log));
  const cachePath = () => join(dataDir(), DATA_FILES.capabilitiesCache);
  const marksPath = () => join(dataDir(), DATA_FILES.unavailable);
  const now = opts.now ?? (() => new Date());

  // Read once at startup only to describe the task types; calls reload it.
  let typeList = "- code\n- debug\n- review\n- research\n- writing\n- design\n- plan\n- quick";
  try {
    typeList = Object.entries(load().policy.taskTypes)
      .map(([name, t]) => (t.description ? `- ${name}: ${t.description}` : `- ${name}`))
      .join("\n");
  } catch {
    // An invalid policy is reported by each tool call.
  }

  // Last capabilities received, so the orchestrator does not resend ~10 KB on every call. Also saved in
  // capabilities-cache.json, so a restart between turns does not lose them (for capabilitiesCacheTtlHours).
  // `savedBy`: for a copy read from disk, the orchestrator it was saved for ("claudeAgent / claude-opus-9-2").
  let cached: (CapabilitiesEntry & { fromDisk: boolean; savedBy?: string }) | undefined;

  // recommend_model calls run one at a time, in the order they arrive. An orchestrator that delegates several
  // children sends its calls together, the first one with the capabilities: handled at once, the others would
  // read the kept capabilities before the first call stores them, and then store their older copy over them.
  let lastCall: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const result = lastCall.then(run);
    lastCall = result.catch(() => undefined);
    return result;
  };

  const requireTaskType = (policy: Policy, taskType: string | undefined) => {
    if (taskType !== undefined && !Object.hasOwn(policy.taskTypes, taskType)) {
      throw new Error(`Unknown taskType "${taskType}". Known types: ${Object.keys(policy.taskTypes).join(", ")}`);
    }
  };

  const server = new McpServer({ name: "t3-autopilot", version: VERSION });

  server.registerTool(
    "recommend_model",
    {
      title: "Recommend a model for delegate_task",
      description:
        "Call before every child task, including ones you would start with your native subagent tool. Returns 1-3 " +
        "candidates, best first; pass a candidate's providerInstanceId, model and options as delegate_task.target " +
        "(sameAsOrchestrator: true means your native subagent tool also works). If the first cannot start because of " +
        "a usage limit or its plan, call mark_unavailable and use the next. Always pass taskType, one of:\n" +
        typeList,
      inputSchema: {
        task: z.string().min(1).describe("One line describing what the child will do."),
        taskType: z
          .string()
          .optional()
          .describe(
            "Task type from the list in the description. Pass it; the keyword classifier is only a last resort.",
          ),
        size: z.enum(["small", "medium", "large"]).optional().describe("Rough size of the task. Shifts effort."),
        criticality: z.enum(["low", "normal", "high"]).optional().describe("How costly a mistake is. Shifts effort."),
        capabilities: z
          .union([z.object({}).passthrough(), z.string(), z.array(z.unknown())])
          .optional()
          .describe(
            "The complete output of T3 Code's orchestrator_capabilities, exactly as returned and never trimmed " +
              "(object, JSON string, providers array, or a list of outputs). Needed on the first call; later calls " +
              "reuse the last one received.",
          ),
        mergeCapabilities: z
          .boolean()
          .optional()
          .describe(
            "Merge `capabilities` into the ones kept from earlier calls (use it for orchestrator_capabilities `search` output).",
          ),
        usage: z
          .array(ProviderUsageSchema)
          .optional()
          .describe("Optional usage percentages per provider instance, if you know them (e.g. from /usage-limits)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      inTurn(async () => {
        try {
          const { policy } = load();
          const usageSource = opts.usageSource ?? createUsageSource(policy);
          const at = now();
          const ttl = policy.capabilitiesCacheTtlHours;
          // The kept capabilities: in memory, else the saved copy if it is younger than the TTL.
          const kept = () => {
            if (cached) return cached;
            const saved = loadCapabilitiesCache(cachePath(), ttl, at);
            if (!saved) return undefined;
            const { inheritedProviderInstanceId: provider, inheritedModel: model } = saved.capabilities;
            return {
              ...saved,
              fromDisk: true,
              ...(provider ? { savedBy: `${provider}${model ? ` / ${model}` : ""}` } : {}),
            };
          };
          let entry: NonNullable<typeof cached>;
          let capabilitiesFrom: "call" | "cache" | "disk-cache" | "merged";
          let keep = true;
          const notes: string[] = [];
          if (args.capabilities !== undefined) {
            // `listed`: how many outputs were passed as a list ([full, search, ...]); 0 for a single output.
            const { capabilities: given, outputs: listed } = parseCapabilitiesInput(args.capabilities);
            const base = args.mergeCapabilities ? kept() : undefined;
            if (base) {
              const capabilities = mergeCapabilities([base.capabilities, given]);
              entry = { ...base, capabilities, merged: true };
              capabilitiesFrom = "merged";
            } else {
              entry = { capabilities: given, receivedAt: at.toISOString(), merged: listed > 1, fromDisk: false };
              capabilitiesFrom = "call";
              // A lone output passed for merging is most likely a search: not a catalog to keep.
              if (args.mergeCapabilities && listed === 0) {
                keep = false;
                notes.push(NOTHING_TO_MERGE);
              }
            }
          } else {
            const base = kept();
            if (!base) throw new Error(NO_CAPABILITIES);
            entry = base;
            capabilitiesFrom = base.fromDisk ? "disk-cache" : "cache";
          }
          const age = at.getTime() - Date.parse(entry.receivedAt);
          if (entry.fromDisk) {
            // Who saved the copy, not who is asking: a merged output brings the caller's own provider and model.
            const who = entry.savedBy ? ` by an orchestrator on ${entry.savedBy}` : "";
            notes.push(
              `Capabilities from the disk cache (the server restarted): received ${formatAge(age)} ago${who}. ` +
                "If that is not you, or a child cannot start or its model id is rejected, call orchestrator_capabilities " +
                "and pass its full output as capabilities.",
            );
          }
          // Kept before the recommendation: if that fails (an unknown taskType, say), the capabilities this call
          // brought are still good, and the calls sent with it, which omit them, must find them.
          if (keep) {
            const changed = cached !== entry;
            cached = entry;
            if (changed && ttl > 0 && capabilitiesFrom !== "disk-cache") {
              try {
                const { fromDisk: _fromDisk, savedBy: _savedBy, ...saved } = entry;
                saveCapabilitiesCache(cachePath(), saved);
              } catch (e) {
                notes.push(`Could not save the capabilities cache: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
          const { mergeCapabilities: _merge, capabilities: _caps, ...rest } = args;
          const unavailable = activeMarks(marksPath(), at);
          const result = await recommendModel(
            { ...rest, capabilities: entry.capabilities, unavailable },
            policy,
            usageSource,
          );
          return ok({
            ...result,
            warnings: [...notes, ...result.warnings],
            capabilitiesFrom,
            ...(capabilitiesFrom === "call" ? {} : { capabilitiesAgeMinutes: Math.max(0, Math.floor(age / 60_000)) }),
          });
        } catch (e) {
          return fail(e);
        }
      }),
  );

  server.registerTool(
    "log_delegation",
    {
      title: "Log a delegation",
      description:
        "Optional. Record a delegate_task you just made; returns a delegationId to pass to log_outcome later. " +
        "log_outcome also works without it.",
      inputSchema: {
        taskType: z.string(),
        providerInstanceId: z.string().min(1),
        model: z.string().min(1),
        options: z.array(SelectedOptionSchema).optional(),
        recommendedRank: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe("1-based rank of the recommend_model candidate you used; null if you chose something else."),
        childThreadId: z.string().optional(),
        summary: z.string().optional().describe("Short task summary (kept to 200 characters). Avoid secrets."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        requireTaskType(load().policy, args.taskType);
        const record = logDelegation(getLogPath(), args);
        return ok({ delegationId: record.id, logged: record });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "log_outcome",
    {
      title: "Log the outcome of a delegation",
      description:
        "Call after reviewing a child's result. Pass delegationId (from log_delegation) or taskType + " +
        "providerInstanceId + model. outcome: success (accepted as is), corrected (needed fixes) or failure.",
      inputSchema: {
        delegationId: z.string().optional(),
        taskType: z.string().optional(),
        providerInstanceId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        outcome: z.enum(OUTCOMES),
        note: z.string().optional().describe("Short note (kept to 200 characters). Avoid secrets."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        requireTaskType(load().policy, args.taskType);
        return ok({ logged: logOutcome(getLogPath(), args) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "mark_unavailable",
    {
      title: "Mark a provider or model unavailable",
      description:
        'Call when a child cannot start, or stops at once, because of a usage limit or its plan (for example "not ' +
        'included in your weekly usage"). Until `until` (' +
        `${UNAVAILABLE_DEFAULT_HOURS} h from now by default), recommend_model moves that provider instance, or only ` +
        "that model, after every other candidate and gives the reason. Not for poor results: those are log_outcome " +
        "failure. clear: true removes marks instead.",
      inputSchema: {
        providerInstanceId: z.string().min(1),
        model: z
          .string()
          .min(1)
          .optional()
          .describe("Model id. Omit it when the whole provider instance is unavailable."),
        reason: z
          .string()
          .min(1)
          .optional()
          .describe("What failed, briefly (kept to 200 characters). Required unless clear is true."),
        until: z
          .string()
          .optional()
          .describe(
            `ISO date when it should work again (for example the resetsAt of the usage window). Default: ${UNAVAILABLE_DEFAULT_HOURS} h from now.`,
          ),
        clear: z
          .boolean()
          .optional()
          .describe("Remove the marks of this provider instance (only this model's when model is given)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const at = now();
        const path = marksPath();
        if (args.clear) {
          const cleared = clearUnavailable(path, args, at);
          return ok({ cleared, active: activeMarks(path, at) });
        }
        if (args.reason === undefined) throw new Error("mark_unavailable needs a reason (or clear: true)");
        const marked = markUnavailable(path, { ...args, reason: args.reason }, at);
        return ok({ marked, active: activeMarks(path, at) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_stats",
    {
      title: "Delegation statistics",
      description:
        "Summary of the local delegation log by task type and model: counts, outcomes and success rate; also the " +
        "mark_unavailable marks in force.",
      inputSchema: {
        since: z.string().optional().describe("ISO date (YYYY-MM-DD or full timestamp); only records from then on."),
        taskType: z.string().optional().describe("Only this task type."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        let since: Date | undefined;
        if (args.since !== undefined) {
          since = new Date(args.since);
          if (Number.isNaN(since.getTime())) throw new Error(`Invalid date in since: "${args.since}"`);
        }
        const path = getLogPath();
        const stats = computeStats(readLog(path), { since });
        const unavailable = activeMarks(marksPath(), now());
        if (args.taskType !== undefined) {
          const only = Object.hasOwn(stats.byTaskType, args.taskType) ? stats.byTaskType[args.taskType] : undefined;
          return ok({ log: path, taskType: args.taskType, stats: only ?? null, unavailable });
        }
        return ok({ log: path, ...stats, unavailable });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
