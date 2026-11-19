import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Capabilities, mergeCapabilities, parseCapabilities, SelectedOptionSchema } from "./capabilities.js";
import { computeStats, logDelegation, logOutcome, OUTCOMES, readLog } from "./log.js";
import { logPath as defaultLogPath } from "./paths.js";
import { type LoadedPolicy, loadPolicy, type Policy } from "./policy.js";
import { recommendModel } from "./recommend.js";
import { createUsageSource, ProviderUsageSchema, type UsageSource } from "./usage.js";

export const VERSION = "0.1.0";

const NOTHING_TO_MERGE =
  "mergeCapabilities: there were no earlier capabilities to merge into (first call, or the server restarted), so only " +
  "this output was used. If it is a search output, pass the full orchestrator_capabilities output too, as " +
  "capabilities: [full, search].";

export interface ServerOptions {
  /** Loads the policy; called on every tool call so edits apply without a restart. */
  loadPolicy?: () => LoadedPolicy;
  usageSource?: UsageSource;
  logPath?: () => string;
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
  const getLogPath = opts.logPath ?? defaultLogPath;

  // Read once at startup only to describe the task types; calls reload it.
  let typeList = "- code\n- debug\n- review\n- research\n- writing\n- design\n- plan\n- quick";
  try {
    typeList = Object.entries(load().policy.taskTypes)
      .map(([name, t]) => (t.description ? `- ${name}: ${t.description}` : `- ${name}`))
      .join("\n");
  } catch {
    // An invalid policy is reported by each tool call.
  }

  // Last capabilities received, so the orchestrator does not resend ~10 KB on every call.
  let cached: Capabilities | undefined;

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
        "(sameAsOrchestrator: true means your native subagent tool also works). If the first cannot start or hits a " +
        "usage limit, use the next. Always pass taskType, one of:\n" +
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
            "Output of T3 Code's orchestrator_capabilities, as returned (object, JSON string, providers array, or a " +
              "list of outputs). Needed on the first call; later calls reuse the last one received.",
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
    async (args) => {
      try {
        const { policy } = load();
        const usageSource = opts.usageSource ?? createUsageSource(policy);
        let capabilities: Capabilities;
        let capabilitiesFrom: "call" | "cache" | "merged";
        const notes: string[] = [];
        if (args.capabilities !== undefined) {
          const given = parseCapabilities(args.capabilities);
          if (args.mergeCapabilities && cached) {
            capabilities = mergeCapabilities([cached, given]);
            capabilitiesFrom = "merged";
          } else {
            capabilities = given;
            capabilitiesFrom = "call";
            if (args.mergeCapabilities) notes.push(NOTHING_TO_MERGE);
          }
        } else if (cached) {
          capabilities = cached;
          capabilitiesFrom = "cache";
        } else {
          throw new Error(
            "No capabilities yet: call orchestrator_capabilities and pass its full output as `capabilities` (later calls can omit it).",
          );
        }
        const { mergeCapabilities: _merge, capabilities: _caps, ...rest } = args;
        const result = await recommendModel({ ...rest, capabilities }, policy, usageSource);
        cached = capabilities;
        return ok({ ...result, warnings: [...notes, ...result.warnings], capabilitiesFrom });
      } catch (e) {
        return fail(e);
      }
    },
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
        providerInstanceId: z.string(),
        model: z.string(),
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
        providerInstanceId: z.string().optional(),
        model: z.string().optional(),
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
    "get_stats",
    {
      title: "Delegation statistics",
      description: "Summary of the local delegation log by task type and model: counts, outcomes and success rate.",
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
        if (args.taskType !== undefined) {
          const only = Object.hasOwn(stats.byTaskType, args.taskType) ? stats.byTaskType[args.taskType] : undefined;
          return ok({ log: path, taskType: args.taskType, stats: only ?? null });
        }
        return ok({ log: path, ...stats });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
