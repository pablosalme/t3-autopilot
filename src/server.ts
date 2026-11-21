import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mergeCapabilities, SelectedOptionSchema } from "./capabilities.js";
import {
  type CapabilitiesEntry,
  formatAge,
  loadCapabilitiesCache,
  saveCapabilitiesCache,
} from "./capabilitiesCache.js";
import {
  DEFAULT_HOST,
  HOSTS,
  isOwnKey,
  resolveHost,
  splitOwn,
  storageKey,
  viewItems,
  viewKey,
  viewOf,
  viewPolicy,
} from "./hosts/index.js";
import type { HostAdapter, HostContext } from "./hosts/types.js";
import { computeStats, type LogRecord, logDelegation, logOutcome, OUTCOMES, readLog, recordsOf } from "./log.js";
import { autopilotHome, DATA_FILES } from "./paths.js";
import { type LoadedPolicy, loadPolicy, type Policy } from "./policy.js";
import { eligibleProviders, recommendModel } from "./recommend.js";
import {
  QUOTA_WINDOW_HOURS,
  QUOTA_WINDOWS,
  QUOTAS,
  quotaWindowOf,
  ROLES,
  readSubscriptions,
  type Subscriptions,
  validateProfile,
  writeSubscriptions,
} from "./subscriptions.js";
import { resolveTaskType } from "./taskTypes.js";
import {
  activeMarks,
  clearUnavailable,
  markUnavailable,
  UNAVAILABLE_DEFAULT_HOURS,
  type UnavailableMark,
} from "./unavailable.js";
import { createUsageSource, ProviderUsageSchema, type UsageSource } from "./usage.js";

export const VERSION = "0.1.3";

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
  /** The hosts the server knows, the default one first: the registry's (src/hosts/index.ts) by default. */
  hosts?: readonly HostAdapter[];
}

/** A log record as its host sees it: its `providerInstanceId` without the host's prefix. */
function viewRecord<T extends LogRecord>(host: HostAdapter, record: T): T {
  return record.providerInstanceId === undefined
    ? record
    : { ...record, providerInstanceId: viewKey(host, record.providerInstanceId) };
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
  const hosts = opts.hosts?.length ? opts.hosts : HOSTS;
  const cachePath = (host: HostAdapter) => join(dataDir(), host.cacheFile);
  const marksPath = () => join(dataDir(), DATA_FILES.unavailable);
  const subscriptionsPath = () => join(dataDir(), DATA_FILES.subscriptions);
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

  // Each host's ids (in marks, profiles, the log and the policy) carry its prefix on disk, T3's none; tools take and
  // return them bare. viewOf, viewItems and viewPolicy show stored keys as host H sees them (its own ids bare, other
  // hosts' with their prefix), so the engine recommends only H's providers yet sees quota pool mates of other hosts.
  const host0 = hosts[0] ?? DEFAULT_HOST;
  const hostIds = hosts.map((h) => h.id) as [string, ...string[]];
  const hostList = hosts.map((h) => `${h.id} (${h.name})`).join(", ");
  const hostArg = z
    .enum(hostIds)
    .optional()
    .describe(
      `The host you run in: ${hostList}. Default: the host of this server's last recommend_model call, else ${host0.id}.`,
    );

  // The host of the last recommend_model call: one stdio process serves one agent session, which runs in one host,
  // so a call that names no host is for that one.
  let lastHost: HostAdapter | undefined;
  /** The host of a call that brings no capabilities: the one it names, else the last recommend_model call's. */
  const hostOf = (id: string | undefined) => resolveHost({ host: id, last: lastHost }, hosts);

  // Last capabilities received per host, so the orchestrator does not resend ~10 KB on every call. Also saved in the
  // host's cache file, so a restart between turns does not lose them (for capabilitiesCacheTtlHours).
  // `savedBy`: for a copy read from disk, the orchestrator it was saved for ("claudeAgent / claude-opus-9-2").
  type Kept = CapabilitiesEntry & { fromDisk: boolean; savedBy?: string };
  const cached = new Map<string, Kept>();

  // The kept capabilities of a host: in memory, else the saved copy if it is younger than the TTL.
  const keptCapabilities = (host: HostAdapter, ttl: number, at: Date): Kept | undefined => {
    const inMemory = cached.get(host.id);
    if (inMemory) return inMemory;
    const saved = loadCapabilitiesCache(cachePath(host), ttl, at);
    if (!saved) return undefined;
    const { inheritedProviderInstanceId: provider, inheritedModel: model } = saved.capabilities;
    return {
      ...saved,
      fromDisk: true,
      ...(provider ? { savedBy: `${provider}${model ? ` / ${model}` : ""}` } : {}),
    };
  };

  /** A host's eligible providers of its kept capabilities with no subscription profile; null when none are kept. */
  const withoutProfile = (host: HostAdapter, policy: Policy, own: Subscriptions): string[] | null => {
    const caps = keptCapabilities(host, policy.capabilitiesCacheTtlHours, now())?.capabilities;
    if (!caps) return null;
    const inherited = caps.inheritedProviderInstanceId ?? undefined;
    return eligibleProviders(caps.providers, viewPolicy(host, policy), inherited, [])
      .map((p) => p.providerInstanceId)
      .filter((id) => !Object.hasOwn(own, id));
  };

  /** The profiles for a host's results: its own, and the other hosts' in `otherHosts` when there are any. */
  const profilesFor = (host: HostAdapter, all: Subscriptions) => {
    const { own, others } = splitOwn(host, all);
    return { subscriptions: own, ...(Object.keys(others).length > 0 ? { otherHosts: others } : {}) };
  };

  /** A host's marks among `marks`, as it sees them. */
  const marksOf = (host: HostAdapter, marks: UnavailableMark[]) =>
    viewItems(
      host,
      marks.filter((m) => isOwnKey(host, m.providerInstanceId)),
    );

  // recommend_model calls run one at a time, in the order they arrive. An orchestrator that delegates several
  // children sends its calls together, the first one with the capabilities: handled at once, the others would
  // read the kept capabilities before the first call stores them, and then store their older copy over them.
  let lastCall: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const result = lastCall.then(run);
    lastCall = result.catch(() => undefined);
    return result;
  };

  // The policy's task type for what the caller passed (an alias too); throws when there is none.
  const requireTaskType = <T extends string | undefined>(policy: Policy, taskType: T): T =>
    (taskType === undefined ? taskType : resolveTaskType(policy, taskType).taskType) as T;

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
            "Task type from the list in the description. Pass it; the keyword classifier is only a last resort. " +
              "Common synonyms (implementation, fix, docs, ...) are accepted; the result's taskType is the type used.",
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
        host: z
          .enum(hostIds)
          .optional()
          .describe(
            `The host you run in: ${hostList}. Default: the host whose output \`capabilities\` is, else the host of ` +
              `this server's last call, else ${host0.id}.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      inTurn(async () => {
        try {
          const host = resolveHost({ host: args.host, payload: args.capabilities, last: lastHost }, hosts);
          lastHost = host;
          const { policy, warnings: policyWarnings } = load();
          const usageSource = opts.usageSource ?? createUsageSource(policy);
          const at = now();
          const ttl = policy.capabilitiesCacheTtlHours;
          const ctx: HostContext = { dataDir: dataDir(), now: at, policy, platform: process.platform };
          const kept = () => keptCapabilities(host, ttl, at);
          let entry: Kept;
          let capabilitiesFrom: "call" | "cache" | "disk-cache" | "merged";
          let keep = true;
          const notes: string[] = [...policyWarnings];
          if (args.capabilities !== undefined) {
            // `listed`: how many outputs were passed as a list ([full, search, ...]); 0 for a single output.
            const catalog = host.catalog({ capabilities: args.capabilities }, ctx);
            const { capabilities: given, outputs: listed } = catalog;
            notes.push(...catalog.notes);
            if (args.mergeCapabilities && !host.merges) {
              notes.push(`mergeCapabilities is ignored: ${host.name} sends its whole catalog in one output.`);
            }
            const merge = args.mergeCapabilities === true && host.merges;
            const base = merge ? kept() : undefined;
            if (base) {
              const capabilities = mergeCapabilities([base.capabilities, given]);
              entry = { ...base, capabilities, merged: true };
              capabilitiesFrom = "merged";
            } else {
              entry = { capabilities: given, receivedAt: at.toISOString(), merged: listed > 1, fromDisk: false };
              capabilitiesFrom = "call";
              // A lone output passed for merging is most likely a search: not a catalog to keep.
              if (merge && listed === 0) {
                keep = false;
                notes.push(host.text.nothingToMerge);
              }
            }
          } else {
            const base = kept();
            if (!base) throw new Error(host.text.noCatalog);
            entry = base;
            capabilitiesFrom = base.fromDisk ? "disk-cache" : "cache";
          }
          const age = at.getTime() - Date.parse(entry.receivedAt);
          if (entry.fromDisk) {
            // Who saved the copy, not who is asking: a merged output brings the caller's own provider and model.
            const who = entry.savedBy ? ` by an orchestrator on ${entry.savedBy}` : "";
            notes.push(
              `Capabilities from the disk cache (the server restarted): received ${formatAge(age)} ago${who}. ` +
                `If that is not you, or a child cannot start or its model id is rejected, ${host.text.capture}.`,
            );
          }
          // Kept before the recommendation: if that fails (an unknown taskType, say), the capabilities this call
          // brought are still good, and the calls sent with it, which omit them, must find them.
          if (keep) {
            const changed = cached.get(host.id) !== entry;
            cached.set(host.id, entry);
            if (changed && ttl > 0 && capabilitiesFrom !== "disk-cache") {
              try {
                const { fromDisk: _fromDisk, savedBy: _savedBy, ...saved } = entry;
                saveCapabilitiesCache(cachePath(host), saved);
              } catch (e) {
                notes.push(`Could not save the capabilities cache: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
          const { mergeCapabilities: _merge, capabilities: _caps, host: _host, ...rest } = args;
          const unavailable = viewItems(host, activeMarks(marksPath(), at));
          const subs = readSubscriptions(subscriptionsPath());
          if (subs.error) {
            notes.push(
              `Subscription profiles are ignored until the file is fixed: ${subs.error}. Tell the user; ` +
                "set_subscription cannot save over an invalid file.",
            );
          }
          const result = await recommendModel(
            {
              ...rest,
              capabilities: entry.capabilities,
              text: host.text,
              unavailable,
              ...(subs.error ? {} : { subscriptions: viewOf(host, subs.subscriptions) }),
            },
            viewPolicy(host, policy),
            usageSource,
          );
          // A host that starts children with a command says how, on each candidate; one it cannot start is skipped.
          const candidates = host.launch
            ? result.candidates.flatMap((candidate) => {
                try {
                  return [{ ...candidate, launch: host.launch?.(candidate, ctx) }];
                } catch (e) {
                  const why = e instanceof Error ? e.message : String(e);
                  result.skipped.push(`${candidate.providerInstanceId}/${candidate.model}: ${why}`);
                  return [];
                }
              })
            : result.candidates;
          return ok({
            ...(host.keyPrefix ? { host: host.id } : {}),
            ...result,
            candidates,
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
        host: hostArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const { host: hostId, ...entry } = args;
        const host = hostOf(hostId);
        const record = logDelegation(getLogPath(), {
          ...entry,
          taskType: requireTaskType(load().policy, entry.taskType),
          providerInstanceId: storageKey(host, entry.providerInstanceId),
          ...(host.keyPrefix ? { host: host.id } : {}),
        });
        return ok({ delegationId: record.id, logged: viewRecord(host, record) });
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
        host: hostArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const { host: hostId, ...input } = args;
        const host = hostOf(hostId);
        const taskType = requireTaskType(load().policy, input.taskType);
        const record = logOutcome(getLogPath(), {
          ...input,
          ...(taskType !== undefined ? { taskType } : {}),
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: storageKey(host, input.providerInstanceId) }
            : {}),
          ...(host.keyPrefix ? { host: host.id } : {}),
        });
        return ok({ logged: viewRecord(host, record) });
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
        "included in your weekly usage\"). Until `until` (by default the quotaWindow of the provider's subscription " +
        `profile, 5h, weekly or monthly, else ${UNAVAILABLE_DEFAULT_HOURS} h from now), recommend_model moves that ` +
        "provider instance, or only that model, after every other candidate except models that cost extra on " +
        "their plan (those go after it), and gives the reason. Not for poor results: those are log_outcome " +
        "failure. clear: true removes marks instead.",
      inputSchema: {
        providerInstanceId: z.string().min(1),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Model id, or a prefix ending in * for every model id that starts with it (e.g. "opencode-go/*" for one ' +
              "plan's models inside a provider instance). Omit it when the whole provider instance is unavailable.",
          ),
        reason: z
          .string()
          .min(1)
          .optional()
          .describe("What failed, briefly (kept to 200 characters). Required unless clear is true."),
        until: z
          .string()
          .optional()
          .describe(
            "ISO date when it should work again (for example the resetsAt of the usage window). Default: the " +
              `quotaWindow of the provider's subscription profile (or of its quotaPool), else ${UNAVAILABLE_DEFAULT_HOURS} h from now.`,
          ),
        clear: z
          .boolean()
          .optional()
          .describe("Remove the marks of this provider instance (only this model's when model is given)."),
        host: hostArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const { host: hostId, ...input } = args;
        const host = hostOf(hostId);
        const at = now();
        const path = marksPath();
        const key = storageKey(host, input.providerInstanceId);
        if (input.clear) {
          const cleared = clearUnavailable(path, { ...input, providerInstanceId: key }, at);
          return ok({ cleared: viewItems(host, cleared), active: marksOf(host, activeMarks(path, at)) });
        }
        if (input.reason === undefined) throw new Error("mark_unavailable needs a reason (or clear: true)");
        let hours = UNAVAILABLE_DEFAULT_HOURS;
        let untilFrom = input.until === undefined ? `default ${UNAVAILABLE_DEFAULT_HOURS} h` : "until";
        if (input.until === undefined) {
          const subs = readSubscriptions(subscriptionsPath());
          // In the host's view, so a quota pool mate of another host lends its window too.
          const found = subs.error
            ? undefined
            : quotaWindowOf(viewOf(host, subs.subscriptions), input.providerInstanceId);
          if (found) {
            hours = QUOTA_WINDOW_HOURS[found.window];
            untilFrom = `quotaWindow ${found.window} of ${found.from}'s subscription profile`;
          }
        }
        const marked = markUnavailable(path, { ...input, providerInstanceId: key, reason: input.reason }, at, hours);
        return ok({
          marked: viewItems(host, [marked])[0],
          untilFrom,
          active: marksOf(host, activeMarks(path, at)),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_subscription",
    {
      title: "Save a provider's subscription profile",
      description:
        "Save what the user told you about the plan behind a provider instance, usually after recommend_model " +
        "returned setupNeeded. Replaces that provider's whole profile (pass every field to keep; get_subscriptions " +
        "shows it); remove: true deletes it. recommend_model then ranks and filters with it: a tight quota or the " +
        "experimental role keeps a provider for families the user has nowhere else and for tasks that are neither " +
        "large nor highly critical; models billed apart (paidFamilies, or not in includedFamilies) and anything " +
        "outside onlyFamilies, avoidFamilies or onlyTaskTypes are used only when nothing else can run; providers " +
        "with the same quotaPool share usage limits.",
      inputSchema: {
        providerInstanceId: z.string().min(1).describe("Provider instance id, as in orchestrator_capabilities."),
        plan: z
          .string()
          .optional()
          .describe('The plan in the user\'s words, e.g. "Claude Max", "OpenCode Go". Required unless remove.'),
        quota: z
          .enum(QUOTAS)
          .optional()
          .describe("generous (rarely hits the limit), standard, or tight (runs out quickly). Required unless remove."),
        purpose: z.string().optional().describe("What the user wants it for, in their words (300 characters at most)."),
        role: z
          .enum(ROLES)
          .optional()
          .describe(
            "primary (any task; the default), secondary (after primary ones), experimental (only what its rules " +
              "allow, like a tight quota) or lastResort (after every other candidate).",
          ),
        quotaPool: z
          .string()
          .optional()
          .describe("Same name on every provider instance that shares one quota (one plan for several apps)."),
        quotaWindow: z
          .enum(QUOTA_WINDOWS)
          .optional()
          .describe("How often the plan's limit resets: 5h, weekly or monthly. Sets how long mark_unavailable lasts."),
        includedFamilies: z
          .array(z.string())
          .optional()
          .describe("Policy families the plan covers; every other family is billed apart."),
        paidFamilies: z
          .array(z.string())
          .optional()
          .describe("Policy families billed apart from the plan (API prices, prepaid credit)."),
        onlyFamilies: z.array(z.string()).optional().describe("Use this provider only for these policy families."),
        avoidFamilies: z.array(z.string()).optional().describe("Never use these policy families on this provider."),
        onlyTaskTypes: z.array(z.string()).optional().describe("Use this provider only for these task types."),
        remove: z.boolean().optional().describe("Delete this provider's profile instead (takes no other field)."),
        host: hostArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const { remove, host: hostId, ...fields } = args;
        const host = hostOf(hostId);
        const { policy } = load();
        const path = subscriptionsPath();
        const current = readSubscriptions(path);
        if (current.error) throw new Error(`${current.error}\nFix or delete that file first; it was not changed.`);
        // Every host's profiles, by stored key: the file is read and written whole.
        const all: Subscriptions = { ...current.subscriptions };
        const id = fields.providerInstanceId;
        const key = storageKey(host, id);
        if (remove) {
          const extra = Object.keys(fields).filter((k) => k !== "providerInstanceId");
          if (extra.length) throw new Error(`remove: true takes only providerInstanceId, not ${extra.join(", ")}`);
          const removed = Object.hasOwn(all, key) ? all[key] : undefined;
          if (removed) {
            delete all[key];
            writeSubscriptions(path, all);
          }
          return ok({
            removed: removed ? { providerInstanceId: id, ...removed } : null,
            file: path,
            ...profilesFor(host, all),
          });
        }
        const profile = validateProfile(fields, policy, now());
        all[key] = profile;
        writeSubscriptions(path, all);
        const profiles = profilesFor(host, all);
        const missing = withoutProfile(host, policy, profiles.subscriptions);
        const warnings: string[] = [];
        const caps = keptCapabilities(host, policy.capabilitiesCacheTtlHours, now())?.capabilities;
        if (caps && !caps.providers.some((p) => p.providerInstanceId === id)) {
          warnings.push(`${id} is not in ${host.text.lastCatalog}; check the providerInstanceId (saved anyway).`);
        }
        if (profile.quotaPool !== undefined) {
          // A pool can be shared across hosts: a mate is any other profile with the same name.
          const mates = Object.keys(all).filter(
            (other) => other !== key && all[other]?.quotaPool === profile.quotaPool,
          );
          if (mates.length === 0) {
            warnings.push(
              `No other provider has quotaPool "${profile.quotaPool}" yet; save the same name on the providers that share it.`,
            );
          }
        }
        return ok({ saved: { providerInstanceId: id, ...profile }, file: path, ...profiles, missing, warnings });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_subscriptions",
    {
      title: "Read the subscription profiles",
      description:
        "The saved subscription profiles by provider instance, and `missing`: providers of the last " +
        "orchestrator_capabilities output that have none (null if no capabilities are kept).",
      inputSchema: { host: hostArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const host = hostOf(args.host);
        const { policy } = load();
        const path = subscriptionsPath();
        const { subscriptions: all, error } = readSubscriptions(path);
        if (error) throw new Error(error);
        const profiles = profilesFor(host, all);
        return ok({ file: path, ...profiles, missing: withoutProfile(host, policy, profiles.subscriptions) });
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
        host: z
          .enum(hostIds)
          .optional()
          .describe(`Only this host's records and marks: ${hostList}. Default: every host's.`),
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
        // Rows and marks keep their stored keys (orca:codex/gpt-6), which say the host of each.
        const only = args.host === undefined ? undefined : resolveHost({ host: args.host }, hosts);
        const keep = (key: string) => only === undefined || isOwnKey(only, key);
        const path = getLogPath();
        const records = readLog(path);
        const stats = computeStats(only ? recordsOf(records, keep) : records, { since });
        const unavailable = activeMarks(marksPath(), now()).filter((m) => keep(m.providerInstanceId));
        const scope = only ? { host: only.id } : {};
        if (args.taskType !== undefined) {
          const one = Object.hasOwn(stats.byTaskType, args.taskType) ? stats.byTaskType[args.taskType] : undefined;
          return ok({ log: path, ...scope, taskType: args.taskType, stats: one ?? null, unavailable });
        }
        return ok({ log: path, ...scope, ...stats, unavailable });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
