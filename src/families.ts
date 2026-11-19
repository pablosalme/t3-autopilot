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
  // Numbers of 5+ digits are snapshot dates (claude-opus-4-20250514), not versions.
  return parts.filter((p) => p.length < 5).map((p) => Number.parseInt(p, 10));
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

/** The family regex that applies to this provider, if any: its driver's pattern, else the "*" pattern. */
export function familyPattern(family: Family, provider: Provider): RegExp | undefined {
  const driver = driverKindOf(provider);
  const pattern = Object.hasOwn(family.match, driver) ? family.match[driver] : family.match["*"];
  return pattern === undefined ? undefined : new RegExp(pattern, "i");
}

export interface Resolved {
  model: Model;
  /** Other models of the family with the same version (gemini-4-neon and gemini-4-argon are both 4). */
  ties: number;
}

/**
 * Resolve a family to the most recent matching model of a provider.
 * On equal versions the model listed first by T3 (the user's order) wins, and
 * `ties` counts the others with that version.
 */
export function resolveFamilyDetail(family: Family, provider: Provider): Resolved | undefined {
  const re = familyPattern(family, provider);
  if (!re) return undefined;
  const exclude = family.exclude ? new RegExp(family.exclude, "i") : undefined;
  let best: { model: Model; key: number[] } | undefined;
  let ties = 0;
  for (const model of provider.models) {
    if (exclude?.test(model.id)) continue;
    const m = re.exec(model.id);
    if (!m) continue;
    const key = versionKey(model.id, m);
    const cmp = best ? compareVersions(key, best.key) : 1;
    if (cmp > 0) {
      best = { model, key };
      ties = 0;
    } else if (cmp === 0) {
      ties++;
    }
  }
  return best && { model: best.model, ties };
}

/** The model {@link resolveFamilyDetail} picks. */
export function resolveFamily(family: Family, provider: Provider): Model | undefined {
  return resolveFamilyDetail(family, provider)?.model;
}
