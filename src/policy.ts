import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { defaultPolicyPath, userPolicyPath } from "./paths.js";

export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_SCALE)[number];

/** T3 option values are strings or booleans. */
const OptionValue = z.union([z.string(), z.boolean()]);

export const CandidateRuleSchema = z
  .object({
    /**
     * Driver kind (e.g. claudeAgent, codex, cursor). Matches every enabled
     * instance of that driver. "*" matches every eligible instance of any
     * driver, in the order orchestrator_capabilities lists them.
     */
    provider: z.string().optional(),
    /** Exact provider instance id. Takes precedence over `provider`. */
    instance: z.string().optional(),
    family: z.string(),
    effort: z.enum(EFFORT_SCALE).optional(),
    /** Extra options to set when the model supports them, e.g. { fastMode: true }. */
    options: z.record(z.string(), OptionValue).optional(),
    /** Never demote this candidate for usage below 100%. */
    noDemote: z.boolean().optional(),
  })
  .refine((c) => c.provider !== undefined || c.instance !== undefined, {
    message: "a candidate needs `provider` (driver kind) or `instance` (provider instance id)",
  });

export const FamilySchema = z.object({
  /** driverKind (or "*") -> regular expression over model ids. */
  match: z.record(z.string(), z.string()),
  /** Optional regular expression; matching ids are ignored. */
  exclude: z.string().optional(),
  /** Words for orchestrator_capabilities `search` that find this family's models (e.g. "opus"). */
  search: z.string().optional(),
});

export const TaskTypeSchema = z.object({
  description: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  avoidInheritedProvider: z.boolean().optional(),
  candidates: z.array(CandidateRuleSchema).min(1),
});

const ShiftSchema = z.record(z.string(), z.number().int());

export const PolicySchema = z.object({
  version: z.literal(1),
  maxCandidates: z.number().int().min(1).max(3).default(3),
  defaultTaskType: z.string(),
  effortOptionIds: z.array(z.string()).min(1),
  effortShift: z
    .object({ size: ShiftSchema.default({}), criticality: ShiftSchema.default({}) })
    .default({ size: {}, criticality: {} }),
  usage: z
    .object({
      source: z.enum(["none"]).default("none"),
      thresholds: z
        .object({
          session: z.number().min(0).max(100).default(80),
          weekly: z.number().min(0).max(100).default(75),
          monthly: z.number().min(0).max(100).default(90),
          other: z.number().min(0).max(100).default(90),
        })
        .default({ session: 80, weekly: 75, monthly: 90, other: 90 }),
    })
    .default({ source: "none", thresholds: { session: 80, weekly: 75, monthly: 90, other: 90 } }),
  excludeProviders: z.array(z.string()).default([]),
  families: z.record(z.string(), FamilySchema),
  taskTypes: z.record(z.string(), TaskTypeSchema),
  fallback: z.array(CandidateRuleSchema).default([]),
  /**
   * When the task type and `fallback` leave free slots, recommend each
   * remaining eligible provider's default model ("auto"/"default"), or its
   * first listed model, marked as low confidence.
   */
  genericFallback: z.boolean().default(true),
});

export type CandidateRule = z.infer<typeof CandidateRuleSchema>;
export type Family = z.infer<typeof FamilySchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type Policy = z.infer<typeof PolicySchema>;

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge a user override onto the default policy.
 * - `families` and `taskTypes`: merged by key; a key in the override replaces
 *   that whole entry. Setting a key to null removes it.
 * - `effortShift`, `usage`: merged one level deep.
 * - Everything else (scalars, arrays such as `fallback`): replaced.
 */
export function mergePolicy(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if ((key === "families" || key === "taskTypes") && isPlain(value)) {
      const merged: Plain = { ...(isPlain(base[key]) ? (base[key] as Plain) : {}) };
      for (const [name, entry] of Object.entries(value)) {
        if (name === "__proto__") continue;
        if (entry === null) delete merged[name];
        else merged[name] = entry;
      }
      out[key] = merged;
    } else if ((key === "effortShift" || key === "usage") && isPlain(value) && isPlain(base[key])) {
      const merged: Plain = { ...(base[key] as Plain) };
      for (const [k, v] of Object.entries(value)) {
        merged[k] = isPlain(v) && isPlain(merged[k]) ? { ...(merged[k] as Plain), ...v } : v;
      }
      out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readYaml(path: string): Plain {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new Error(`${path}: cannot read policy YAML: ${(e as Error).message}`);
  }
  if (raw === null || raw === undefined) return {};
  if (!isPlain(raw)) throw new Error(`${path}: expected a YAML mapping at the top level`);
  return raw;
}

export function validatePolicy(raw: unknown, source: string): Policy {
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid policy (${source}): ${z.prettifyError(parsed.error)}`);
  }
  const policy = parsed.data;
  // Cross-checks the schema cannot express.
  const problems: string[] = [];
  for (const [name, fam] of Object.entries(policy.families)) {
    for (const [driver, pattern] of Object.entries(fam.match)) {
      try {
        new RegExp(pattern);
      } catch (e) {
        problems.push(`families.${name}.match.${driver}: invalid regex (${(e as Error).message})`);
      }
    }
    if (fam.exclude !== undefined) {
      try {
        new RegExp(fam.exclude);
      } catch (e) {
        problems.push(`families.${name}.exclude: invalid regex (${(e as Error).message})`);
      }
    }
  }
  const checkRules = (rules: CandidateRule[], where: string) =>
    rules.forEach((r, i) => {
      if (!Object.hasOwn(policy.families, r.family)) problems.push(`${where}[${i}]: unknown family "${r.family}"`);
    });
  for (const [name, t] of Object.entries(policy.taskTypes)) checkRules(t.candidates, `taskTypes.${name}.candidates`);
  checkRules(policy.fallback, "fallback");
  if (!Object.hasOwn(policy.taskTypes, policy.defaultTaskType)) {
    problems.push(`defaultTaskType "${policy.defaultTaskType}" is not a task type`);
  }
  if (problems.length) throw new Error(`Invalid policy (${source}):\n- ${problems.join("\n- ")}`);
  return policy;
}

export interface LoadedPolicy {
  policy: Policy;
  /** Files the policy was built from, in merge order. */
  sources: string[];
}

/** Load the bundled default policy and apply the user override if present. */
export function loadPolicy(opts: { userPath?: string; defaultPath?: string } = {}): LoadedPolicy {
  const defaultPath = opts.defaultPath ?? defaultPolicyPath();
  const userPath = opts.userPath ?? userPolicyPath();
  let raw = readYaml(defaultPath);
  const sources = [defaultPath];
  if (existsSync(userPath)) {
    raw = mergePolicy(raw, readYaml(userPath));
    sources.push(userPath);
  }
  return { policy: validatePolicy(raw, sources.join(" + ")), sources };
}
