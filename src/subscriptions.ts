import { existsSync, readFileSync } from "node:fs";
import { Document, parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Policy } from "./policy.js";
import { writeTextAtomic } from "./store.js";

/**
 * How much use the plan behind a provider instance allows. `tight`: it runs
 * out quickly (a cheap plan, a trial); such a provider is kept for what its
 * profile says it is for.
 */
export const QUOTAS = ["generous", "standard", "tight"] as const;
export type Quota = (typeof QUOTAS)[number];

/**
 * What the user keeps the provider instance for. `primary` (also no role):
 * any task. `secondary`: after the primary ones. `experimental`: only for what
 * its rules allow, like a `tight` quota. `lastResort`: after every other
 * candidate.
 */
/**
 * How often the plan's limit resets. A usage limit marked with
 * mark_unavailable and no `until` lasts this long instead of 24 hours.
 */
export const QUOTA_WINDOWS = ["5h", "weekly", "monthly"] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];
export const QUOTA_WINDOW_HOURS: Readonly<Record<QuotaWindow, number>> = { "5h": 5, weekly: 168, monthly: 720 };

export const ROLES = ["primary", "secondary", "experimental", "lastResort"] as const;
export type Role = (typeof ROLES)[number];

const PLAN_MAX = 100;
const PURPOSE_MAX = 300;
const POOL_MAX = 60;

const names = (what: string) =>
  z
    .array(z.string().trim().min(1, `${what}: an empty name`))
    .min(1, `${what}: an empty list; omit the key instead`)
    .refine((list) => new Set(list).size === list.length, `${what}: a name is repeated`);

/** One provider instance's subscription profile, as stored in subscriptions.yaml. */
export const SubscriptionProfileSchema = z
  .strictObject({
    /** The plan, in the user's words: "OpenCode Go", "Claude Max", "pay per use". */
    plan: z
      .string()
      .trim()
      .min(1, "plan: say which plan it is, in the user's words")
      .max(PLAN_MAX, `plan: at most ${PLAN_MAX} characters`),
    quota: z.enum(QUOTAS, { error: `quota: one of ${QUOTAS.join(", ")}` }),
    /** What the user wants it for, in their words. Shown in reasons; the rules below are what the ranking reads. */
    purpose: z
      .string()
      .trim()
      .min(1, "purpose: an empty text; omit it instead")
      .max(PURPOSE_MAX, `purpose: at most ${PURPOSE_MAX} characters`)
      .optional(),
    role: z.enum(ROLES, { error: `role: one of ${ROLES.join(", ")}` }).optional(),
    /**
     * Name of a quota shared with other provider instances (one plan that
     * covers several apps, such as Grok and Cursor): every instance with the
     * same name draws from it, so a usage limit on one applies to the others.
     */
    quotaPool: z
      .string()
      .trim()
      .min(1, "quotaPool: an empty name; omit it instead")
      .max(POOL_MAX, `quotaPool: at most ${POOL_MAX} characters`)
      .optional(),
    quotaWindow: z.enum(QUOTA_WINDOWS, { error: `quotaWindow: one of ${QUOTA_WINDOWS.join(", ")}` }).optional(),
    /** Policy families the plan covers; any other family is billed apart (extra cost). */
    includedFamilies: names("includedFamilies").optional(),
    /** Policy families billed apart from the plan (API prices, prepaid credit): extra cost. */
    paidFamilies: names("paidFamilies").optional(),
    /** Policy families this provider is for; candidates of other families break its rules. */
    onlyFamilies: names("onlyFamilies").optional(),
    /** Policy families never to use on this provider. */
    avoidFamilies: names("avoidFamilies").optional(),
    /** Task types this provider is for; other task types break its rules. */
    onlyTaskTypes: names("onlyTaskTypes").optional(),
    /** When set_subscription last saved it. */
    updatedAt: z.string().optional(),
  })
  .refine((p) => !(p.onlyFamilies && p.avoidFamilies), {
    message:
      "onlyFamilies and avoidFamilies: use one or the other (onlyFamilies already leaves out every other family)",
  })
  .refine((p) => !p.includedFamilies?.some((f) => p.paidFamilies?.includes(f)), {
    message: "includedFamilies and paidFamilies: a family cannot be in both",
  });

export type SubscriptionProfile = z.infer<typeof SubscriptionProfileSchema>;
export type Subscriptions = Record<string, SubscriptionProfile>;

const FileSchema = z.strictObject({
  version: z.literal(1),
  subscriptions: z.record(z.string().min(1), SubscriptionProfileSchema).nullish(),
});

export interface ReadSubscriptions {
  subscriptions: Subscriptions;
  /** Why the file could not be used; its profiles are then ignored. */
  error?: string;
}

/** The profiles in the file. A missing file has none; an invalid one has none and an `error`. */
export function readSubscriptions(path: string): ReadSubscriptions {
  if (!existsSync(path)) return { subscriptions: {} };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    return { subscriptions: {}, error: `${path}: cannot read it as YAML: ${(e as Error).message}` };
  }
  if (raw === null || raw === undefined) return { subscriptions: {} };
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) return { subscriptions: {}, error: `${path}: ${z.prettifyError(parsed.error)}` };
  const subscriptions: Subscriptions = {};
  for (const [id, profile] of Object.entries(parsed.data.subscriptions ?? {})) {
    if (id !== "__proto__") subscriptions[id] = profile;
  }
  return { subscriptions };
}

const HEADER = [
  " t3-autopilot subscription profiles, one per provider instance id.",
  " Written by the set_subscription tool; you can also edit it by hand.",
  " Keys: plan, quota (generous | standard | tight), purpose, role",
  " (primary | secondary | experimental | lastResort), quotaPool, quotaWindow",
  " (5h | weekly | monthly),",
  " includedFamilies or paidFamilies, onlyFamilies or avoidFamilies,",
  " onlyTaskTypes. See docs/reference.md#subscription-profiles:",
  " https://github.com/pablosalme/t3-autopilot/blob/main/docs/reference.md#subscription-profiles",
].join("\n");

/** The order of a profile's keys in the file, whatever order they were given in. */
const KEY_ORDER: readonly (keyof SubscriptionProfile)[] = [
  "plan",
  "quota",
  "purpose",
  "role",
  "quotaPool",
  "quotaWindow",
  "includedFamilies",
  "paidFamilies",
  "onlyFamilies",
  "avoidFamilies",
  "onlyTaskTypes",
  "updatedAt",
];

function ordered(profile: SubscriptionProfile): SubscriptionProfile {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (profile[key] !== undefined) out[key] = profile[key];
  return out as SubscriptionProfile;
}

/** Write every profile, atomically and readable by its owner only. */
export function writeSubscriptions(path: string, subscriptions: Subscriptions): void {
  const sorted = Object.fromEntries(
    Object.entries(subscriptions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, profile]) => [id, ordered(profile)]),
  );
  const doc = new Document({ version: 1, subscriptions: sorted });
  doc.commentBefore = HEADER;
  writeTextAtomic(path, doc.toString({ lineWidth: 0 }));
}

/** Families and task types a profile names that the policy does not have. */
export function unknownNames(profile: SubscriptionProfile, policy: Policy): string[] {
  const out: string[] = [];
  const families = Object.keys(policy.families);
  const taskTypes = Object.keys(policy.taskTypes);
  for (const key of ["onlyFamilies", "avoidFamilies", "includedFamilies", "paidFamilies"] as const) {
    const unknown = (profile[key] ?? []).filter((f) => !Object.hasOwn(policy.families, f));
    if (unknown.length) {
      out.push(`${key}: unknown famil${unknown.length === 1 ? "y" : "ies"} ${unknown.map((f) => `"${f}"`).join(", ")}`);
    }
  }
  const unknownTypes = (profile.onlyTaskTypes ?? []).filter((t) => !Object.hasOwn(policy.taskTypes, t));
  if (unknownTypes.length) {
    out.push(
      `onlyTaskTypes: unknown task type${unknownTypes.length === 1 ? "" : "s"} ${unknownTypes.map((t) => `"${t}"`).join(", ")}`,
    );
  }
  if (out.length) {
    out.push(`known families: ${families.join(", ")}`);
    out.push(`known task types: ${taskTypes.join(", ")}`);
  }
  return out;
}

export interface SetSubscriptionInput {
  providerInstanceId: string;
  plan?: string;
  quota?: string;
  purpose?: string;
  role?: string;
  quotaPool?: string;
  quotaWindow?: string;
  includedFamilies?: string[];
  paidFamilies?: string[];
  onlyFamilies?: string[];
  avoidFamilies?: string[];
  onlyTaskTypes?: string[];
}

/**
 * Validate a profile for set_subscription: the schema, then the family and
 * task type names against the policy. Throws one error that lists every
 * problem.
 */
export function validateProfile(input: SetSubscriptionInput, policy: Policy, now: Date): SubscriptionProfile {
  const { providerInstanceId: _id, ...fields } = input;
  const missing = (["plan", "quota"] as const).filter((k) => fields[k] === undefined);
  if (missing.length) {
    throw new Error(
      `set_subscription needs ${missing.join(" and ")} (or remove: true). Ask the user which plan they have on ` +
        `${input.providerInstanceId} and whether its quota is generous, standard or tight.`,
    );
  }
  const parsed = SubscriptionProfileSchema.safeParse({ ...fields, updatedAt: now.toISOString() });
  if (!parsed.success) {
    throw new Error(`Invalid subscription profile for ${input.providerInstanceId}:\n${z.prettifyError(parsed.error)}`);
  }
  const unknown = unknownNames(parsed.data, policy);
  if (unknown.length) {
    throw new Error(`Invalid subscription profile for ${input.providerInstanceId}:\n- ${unknown.join("\n- ")}`);
  }
  return parsed.data;
}

/** A tight quota or the experimental role: kept for what its rules allow. */
export function isRestricted(profile: SubscriptionProfile): boolean {
  return profile.quota === "tight" || profile.role === "experimental";
}

/** Whether the profile's family rules allow a family (undefined: a model no policy family matches). */
export function allowsFamily(profile: SubscriptionProfile, family: string | undefined): boolean {
  if (profile.onlyFamilies) return family !== undefined && profile.onlyFamilies.includes(family);
  return family === undefined || !(profile.avoidFamilies ?? []).includes(family);
}

/**
 * Whether a family is billed apart from the plan: listed in paidFamilies, or
 * left out of includedFamilies. A model no policy family matches (a provider's
 * "auto" or "default") is not: nothing says it costs extra.
 */
export function isPaidFamily(profile: SubscriptionProfile, family: string | undefined): boolean {
  if (family === undefined) return false;
  if (profile.paidFamilies?.includes(family)) return true;
  return profile.includedFamilies !== undefined && !profile.includedFamilies.includes(family);
}

const ROLE_TIER: Record<Role, number> = { primary: 0, secondary: 1, experimental: 2, lastResort: 3 };

/** "OpenCode Go, quota tight, experimental": a profile in a reason or a warning. */
export function describeProfile(profile: SubscriptionProfile): string {
  return [
    profile.plan,
    `quota ${profile.quota}`,
    ...(profile.quotaPool ? [`pool ${profile.quotaPool}`] : []),
    ...(profile.quotaWindow ? [`resets ${profile.quotaWindow}`] : []),
    ...(profile.role ? [profile.role] : []),
  ].join(", ");
}

export interface ProfileCheck {
  family: string | undefined;
  taskType: string;
  size: "small" | "medium" | "large";
  criticality: "low" | "normal" | "high";
  /** Other eligible provider instances, without a restricted profile, that offer the family. */
  familyElsewhere: readonly string[];
}

export interface ProfileVerdict {
  /** Ranking among the candidates that fit: 0 none, 1 secondary or tight, 2 experimental, 3 lastResort. */
  tier: number;
  /** Why the candidate breaks the profile; empty when it fits. */
  outside: string[];
  /** Why the model costs extra on this plan (billed apart); undefined when it is included. */
  extraCost?: string;
  /** What the profile did, for the reason; empty when it changed nothing. */
  note?: string;
}

/**
 * Check a candidate against its provider's profile. Every profile applies its
 * `only*` and `avoidFamilies` rules. A restricted one (tight quota or
 * experimental role) is also not for a family the user has on another
 * provider, nor for a large or highly critical task.
 */
export function evaluateProfile(profile: SubscriptionProfile, c: ProfileCheck): ProfileVerdict {
  const outside: string[] = [];
  if (!allowsFamily(profile, c.family)) {
    const which = c.family ?? "a model no policy family matches";
    outside.push(
      profile.onlyFamilies
        ? `${which} is not in onlyFamilies (${profile.onlyFamilies.join(", ")})`
        : `${which} is in avoidFamilies`,
    );
  }
  if (profile.onlyTaskTypes && !profile.onlyTaskTypes.includes(c.taskType)) {
    outside.push(`task type ${c.taskType} is not in onlyTaskTypes (${profile.onlyTaskTypes.join(", ")})`);
  }
  const restricted = isRestricted(profile);
  if (restricted) {
    if (c.family !== undefined && c.familyElsewhere.length > 0 && !profile.onlyFamilies?.includes(c.family)) {
      outside.push(`${c.family} is also on ${c.familyElsewhere.join(", ")}`);
    }
    if (c.size === "large") outside.push("the task is large");
    if (c.criticality === "high") outside.push("the task is highly critical");
  }
  const tier = Math.max(profile.role ? ROLE_TIER[profile.role] : 0, profile.quota === "tight" ? 1 : 0);
  const what = `subscription ${describeProfile(profile)}`;
  const extraCost = isPaidFamily(profile, c.family)
    ? `${c.family} is billed apart from the plan (${profile.paidFamilies?.includes(c.family as string) ? "paidFamilies" : "not in includedFamilies"})`
    : undefined;
  const cost = extraCost ? { extraCost } : {};
  const why = [...outside, ...(extraCost ? [`extra cost: ${extraCost}`] : [])];
  if (why.length) return { tier, outside, ...cost, note: `${what}: outside its profile (${why.join("; ")})` };
  const matched = [
    ...(profile.onlyFamilies && c.family ? [`onlyFamilies ${c.family}`] : []),
    ...(profile.onlyTaskTypes ? [`onlyTaskTypes ${c.taskType}`] : []),
    ...(profile.includedFamilies && c.family ? [`included in the plan: ${c.family}`] : []),
  ];
  if (matched.length) return { tier, outside, note: `${what}: fits its profile (${matched.join(", ")})` };
  if (restricted) return { tier, outside, note: `${what}: fits its profile, ranked after unrestricted subscriptions` };
  if (tier > 0) return { tier, outside, note: `${what}: ranked after primary subscriptions` };
  return { tier, outside };
}

/**
 * The quota window that sets how long a mark on this provider instance lasts:
 * its own profile's, else that of another instance of its quota pool.
 */
export function quotaWindowOf(
  subscriptions: Readonly<Subscriptions>,
  providerInstanceId: string,
): { window: QuotaWindow; from: string } | undefined {
  const profile = Object.hasOwn(subscriptions, providerInstanceId) ? subscriptions[providerInstanceId] : undefined;
  if (!profile) return undefined;
  if (profile.quotaWindow) return { window: profile.quotaWindow, from: providerInstanceId };
  if (profile.quotaPool === undefined) return undefined;
  for (const [id, other] of Object.entries(subscriptions)) {
    if (id !== providerInstanceId && other.quotaPool === profile.quotaPool && other.quotaWindow) {
      return { window: other.quotaWindow, from: id };
    }
  }
  return undefined;
}
