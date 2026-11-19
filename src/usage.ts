import { z } from "zod";
import type { Policy } from "./policy.js";

/**
 * Usage windows mirror T3 Code's own `ServerProviderUsageWindow`
 * (kind + percent used + reset time, optionally scoped to some models), so a
 * future source that reads them from T3 needs no translation.
 */
export const USAGE_KINDS = ["session", "weekly", "monthly", "other"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * Deliberately loose: a window with an unknown `kind` or a percentage outside
 * 0-100 is ignored when evaluating usage, instead of failing the whole call.
 */
export const UsageWindowSchema = z.object({
  kind: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().optional(),
  /** If present, the window only applies to these model ids. */
  modelIds: z.array(z.string()).optional(),
});

export const ProviderUsageSchema = z.object({
  providerInstanceId: z.string(),
  windows: z.array(UsageWindowSchema),
});

export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

/** Where usage percentages come from. Unknown usage must be reported as absent, never guessed. */
export interface UsageSource {
  readonly name: string;
  /** Usage per provider instance id. Missing ids mean "unknown". */
  getUsage(providerInstanceIds: readonly string[]): Promise<Map<string, ProviderUsage>>;
}

/** No usage data. Every candidate is treated as "unknown", which never penalises. */
export class NoneUsageSource implements UsageSource {
  readonly name = "none";
  async getUsage(): Promise<Map<string, ProviderUsage>> {
    return new Map();
  }
}

/** Fixed usage data; used for usage passed in a call and in tests. */
export class StaticUsageSource implements UsageSource {
  readonly name: string;
  private readonly data: Map<string, ProviderUsage>;
  constructor(entries: readonly ProviderUsage[], name = "static") {
    this.name = name;
    this.data = new Map(entries.map((e) => [e.providerInstanceId, e]));
  }
  async getUsage(ids: readonly string[]): Promise<Map<string, ProviderUsage>> {
    return new Map(
      ids.flatMap((id) => {
        const usage = this.data.get(id);
        return usage ? [[id, usage] as const] : [];
      }),
    );
  }
}

export function createUsageSource(policy: Policy): UsageSource {
  switch (policy.usage.source) {
    case "none":
      return new NoneUsageSource();
  }
}

/** 0 = fine or unknown, 1 = above threshold, 2 = exhausted (>= 100%). */
export type UsageTier = 0 | 1 | 2;

export interface UsageVerdict {
  tier: UsageTier;
  note?: string;
}

/** Known kind and a finite percentage in 0-100. Anything else is ignored. */
export function isUsableWindow(w: UsageWindow): w is UsageWindow & { kind: UsageKind } {
  return (
    (USAGE_KINDS as readonly string[]).includes(w.kind) &&
    Number.isFinite(w.usedPercent) &&
    w.usedPercent >= 0 &&
    w.usedPercent <= 100
  );
}

/** Evaluate one provider/model against the policy thresholds. */
export function evaluateUsage(usage: ProviderUsage | undefined, modelId: string, policy: Policy): UsageVerdict {
  if (!usage) return { tier: 0 };
  let worst: UsageVerdict = { tier: 0 };
  for (const w of usage.windows) {
    if (!isUsableWindow(w)) continue;
    if (w.modelIds && !w.modelIds.includes(modelId)) continue;
    const threshold = policy.usage.thresholds[w.kind];
    let tier: UsageTier = 0;
    if (w.usedPercent >= 100) tier = 2;
    else if (w.usedPercent >= threshold) tier = 1;
    if (tier > worst.tier) {
      const reset = w.resetsAt ? `, resets ${w.resetsAt}` : "";
      worst = {
        tier,
        note:
          tier === 2
            ? `${w.kind} usage exhausted (${w.usedPercent}%${reset})`
            : `${w.kind} usage ${w.usedPercent}% >= ${threshold}%${reset}`,
      };
    }
  }
  return worst;
}
