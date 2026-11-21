import { z } from "zod";

/*
 * The schemas t3-autopilot 0.1.3 reads its data files with, copied from its sources (src/subscriptions.ts,
 * src/unavailable.ts, src/capabilities.ts and src/capabilitiesCache.ts at dde8c3d) and frozen here: a 0.1.x
 * server and a newer one share ~/.t3-autopilot (an `npx -y` in one session and another in the next), so what
 * the newer one writes must still pass them. Never update them to match src/.
 */

// subscriptions.yaml: strict at every level, version 1.
const QUOTAS = ["generous", "standard", "tight"] as const;
const QUOTA_WINDOWS = ["5h", "weekly", "monthly"] as const;
const ROLES = ["primary", "secondary", "experimental", "lastResort"] as const;
const names = (what: string) =>
  z
    .array(z.string().trim().min(1, `${what}: an empty name`))
    .min(1, `${what}: an empty list; omit the key instead`)
    .refine((list) => new Set(list).size === list.length, `${what}: a name is repeated`);

export const SubscriptionProfileSchema = z
  .strictObject({
    plan: z.string().trim().min(1).max(100),
    quota: z.enum(QUOTAS),
    purpose: z.string().trim().min(1).max(300).optional(),
    role: z.enum(ROLES).optional(),
    quotaPool: z.string().trim().min(1).max(60).optional(),
    quotaWindow: z.enum(QUOTA_WINDOWS).optional(),
    includedFamilies: names("includedFamilies").optional(),
    paidFamilies: names("paidFamilies").optional(),
    onlyFamilies: names("onlyFamilies").optional(),
    avoidFamilies: names("avoidFamilies").optional(),
    onlyTaskTypes: names("onlyTaskTypes").optional(),
    updatedAt: z.string().optional(),
  })
  .refine((p) => !(p.onlyFamilies && p.avoidFamilies))
  .refine((p) => !p.includedFamilies?.some((f) => p.paidFamilies?.includes(f)));

export const SubscriptionsFileSchema = z.strictObject({
  version: z.literal(1),
  subscriptions: z.record(z.string().min(1), SubscriptionProfileSchema).nullish(),
});

// unavailable.json.
export const UnavailableMarkSchema = z.object({
  providerInstanceId: z.string(),
  model: z.string().optional(),
  reason: z.string(),
  markedAt: z.string(),
  until: z.string(),
});
export const MarksFileSchema = z.object({ version: z.literal(1), marks: z.array(UnavailableMarkSchema) });

// capabilities-cache.json.
const OptionValue = z.union([z.string(), z.boolean()]);
const ModelOptionSchema = z
  .object({ id: z.string(), values: z.array(OptionValue).optional(), default: OptionValue.optional() })
  .passthrough();
const ModelSchema = z
  .object({ id: z.string(), label: z.string().nullish(), options: z.array(ModelOptionSchema).optional() })
  .passthrough();
const ProviderSchema = z
  .object({
    providerInstanceId: z.string(),
    driverKind: z.string().nullish(),
    displayName: z.string().nullish(),
    models: z.array(ModelSchema).default([]),
    omittedModels: z.number().int().min(0).optional(),
    canRunChildTask: z.boolean().default(false),
    canRunCrossProviderChildTask: z.boolean().optional(),
    constraints: z.array(z.string()).nullish(),
    mergedOutputs: z.number().int().optional(),
    lastOutput: z.object({ models: z.array(z.string()), omittedModels: z.number().int().min(0) }).optional(),
  })
  .passthrough();
const SelectedOptionSchema = z.object({ id: z.string(), value: OptionValue });
export const CapabilitiesSchema = z
  .object({
    inheritedProviderInstanceId: z.string().nullish(),
    inheritedModel: z.string().nullish(),
    inheritedOptions: z.array(SelectedOptionSchema).nullish(),
    providers: z.array(ProviderSchema),
  })
  .passthrough();
export const CacheFileSchema = z.object({
  version: z.literal(1),
  receivedAt: z.string(),
  merged: z.boolean(),
  capabilities: CapabilitiesSchema,
});

/**
 * log.jsonl as 0.1.3 reads it: every line that is JSON with `kind` delegation or outcome is a record; nothing
 * else is checked, and computeStats groups by `providerInstanceId/model`.
 */
export function readLog013(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r && (r.kind === "delegation" || r.kind === "outcome")) out.push(r);
    } catch {
      // skipped, as 0.1.3 does
    }
  }
  return out;
}
