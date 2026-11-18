import { driverKindOf, type Model, type Provider } from "./capabilities.js";
import type { Family } from "./policy.js";

/**
 * Version key of a model id that matched a family regex: the numeric capture
 * groups in order, or, when the regex has no numeric groups, every number in
 * the id. `claude-opus-5-5` -> [5, 5]; `grok-4.7` -> [4, 7].
 */
export function versionKey(id: string, match: RegExpExecArray): number[] {
  const groups = match.slice(1).filter((g): g is string => g !== undefined && /^\d+$/.test(g));
  const parts = groups.length > 0 ? groups : (id.match(/\d+/g) ?? []);
  return parts.map((p) => Number.parseInt(p, 10));
}

/** Compare version keys; a missing component counts as -1, so 5.5 > 5 > 4.8. */
export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** The family regex that applies to this provider, if any. */
export function familyPattern(family: Family, provider: Provider): RegExp | undefined {
  const pattern = family.match[driverKindOf(provider)] ?? family.match["*"];
  return pattern === undefined ? undefined : new RegExp(pattern);
}

/**
 * Resolve a family to the most recent matching model of a provider.
 * On equal versions the model listed first by T3 wins.
 */
export function resolveFamily(family: Family, provider: Provider): Model | undefined {
  const re = familyPattern(family, provider);
  if (!re) return undefined;
  const exclude = family.exclude ? new RegExp(family.exclude) : undefined;
  let best: { model: Model; key: number[] } | undefined;
  for (const model of provider.models) {
    if (exclude?.test(model.id)) continue;
    const m = re.exec(model.id);
    if (!m) continue;
    const key = versionKey(model.id, m);
    if (!best || compareVersions(key, best.key) > 0) best = { model, key };
  }
  return best?.model;
}
