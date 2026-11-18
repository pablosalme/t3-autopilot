import type { Model, ModelOption, OptionValue, SelectedOption } from "./capabilities.js";
import { EFFORT_SCALE, type Effort } from "./policy.js";

export function shiftEffort(effort: Effort, steps: number): Effort {
  const i = EFFORT_SCALE.indexOf(effort);
  // Shifting never goes below "low": "none"/"minimal" only when asked explicitly.
  const floor = Math.min(i, EFFORT_SCALE.indexOf("low"));
  const j = Math.max(floor, Math.min(EFFORT_SCALE.length - 1, i + steps));
  return EFFORT_SCALE[j] as Effort;
}

/**
 * Pick the supported value closest to the wanted effort: the highest supported
 * value at or below it, otherwise the lowest one above it. Values outside the
 * scale (e.g. "auto", "ultrathink") are never chosen.
 */
export function clampEffort(wanted: Effort, supported: readonly OptionValue[]): Effort | undefined {
  const w = EFFORT_SCALE.indexOf(wanted);
  const ranks = supported
    .filter((v): v is string => typeof v === "string")
    .map((v) => EFFORT_SCALE.indexOf(v as Effort))
    .filter((r) => r >= 0)
    .sort((a, b) => a - b);
  if (ranks.length === 0) return undefined;
  const below = ranks.filter((r) => r <= w);
  const pick = below.length > 0 ? below[below.length - 1] : ranks[0];
  return EFFORT_SCALE[pick as number] as Effort;
}

/** True when an option can carry an effort level: free-form, or at least one value on the scale. */
function takesEffort(opt: ModelOption): boolean {
  return opt.values === undefined || opt.values.some((v) => typeof v === "string" && EFFORT_SCALE.includes(v as Effort));
}

/** Option ids that look like a reasoning control on agents with their own ids (ACP agents). */
const EFFORT_LIKE_ID = /effort|reason|think|thought/i;

/**
 * The option that sets reasoning effort: the first id of `effortOptionIds`
 * that the model declares with effort values, else any option whose id looks
 * like a reasoning control and has effort values. A boolean `thinking` toggle
 * is never used for effort.
 */
export function findEffortOption(declared: readonly ModelOption[], effortOptionIds: readonly string[]): ModelOption | undefined {
  for (const id of effortOptionIds) {
    const opt = declared.find((o) => o.id === id);
    if (opt && takesEffort(opt)) return opt;
  }
  return declared.find((o) => EFFORT_LIKE_ID.test(o.id) && o.values !== undefined && takesEffort(o));
}

export interface BuiltOptions {
  options: SelectedOption[];
  /** The effort actually set, if any. */
  effort?: Effort;
  notes: string[];
}

/**
 * Build the `options` array for delegate_task.target. Only options the model
 * declares are set; values are checked against the declared values.
 */
export function buildOptions(
  model: Model,
  effortOptionIds: readonly string[],
  effort: Effort | undefined,
  extra: Record<string, OptionValue> | undefined,
): BuiltOptions {
  const declared = model.options ?? [];
  const options: SelectedOption[] = [];
  const notes: string[] = [];
  let effortSet: Effort | undefined;

  if (effort) {
    const opt = findEffortOption(declared, effortOptionIds);
    if (!opt) {
      notes.push("model has no effort option; using its default");
    } else {
      const value = opt.values ? clampEffort(effort, opt.values) : effort;
      if (value) {
        options.push({ id: opt.id, value });
        effortSet = value;
        if (value !== effort) notes.push(`effort ${effort} not supported, using ${value}`);
      }
    }
  }

  for (const [id, value] of Object.entries(extra ?? {})) {
    const opt = declared.find((o) => o.id === id);
    if (!opt) continue;
    if (opt.values && !opt.values.includes(value)) continue;
    options.push({ id, value });
  }

  return { options, effort: effortSet, notes };
}
