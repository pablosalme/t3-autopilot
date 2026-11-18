import { z } from "zod";

/**
 * Schema for the output of T3 Code's `orchestrator_capabilities` tool
 * (`OrchestratorMcpCapabilitiesResult` in T3's contracts). Only the fields
 * t3-autopilot reads are declared; everything else passes through. T3 sends
 * `null` for some absent values (inherited provider, display name), so those
 * fields accept null.
 */
/** T3 option values are strings or booleans (`ProviderOptionSelectionValue`). */
const OptionValue = z.union([z.string(), z.boolean()]);

export const ModelOptionSchema = z
  .object({
    id: z.string(),
    values: z.array(OptionValue).optional(),
    default: OptionValue.optional(),
  })
  .passthrough();

export const ModelSchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    options: z.array(ModelOptionSchema).optional(),
  })
  .passthrough();

export const ProviderSchema = z
  .object({
    providerInstanceId: z.string(),
    driverKind: z.string().nullish(),
    displayName: z.string().nullish(),
    models: z.array(ModelSchema).default([]),
    /** Models T3 left out of `models` (short list for large catalogs, or matches past the cap with `search`). */
    omittedModels: z.number().int().min(0).optional(),
    canRunChildTask: z.boolean().default(false),
    canRunCrossProviderChildTask: z.boolean().optional(),
    constraints: z.array(z.string()).nullish(),
    /** Set by t3-autopilot when the provider was completed with a second capabilities output (e.g. a `search`). */
    mergedOutputs: z.number().int().optional(),
  })
  .passthrough();

export const SelectedOptionSchema = z.object({ id: z.string(), value: OptionValue });

export const CapabilitiesSchema = z
  .object({
    inheritedProviderInstanceId: z.string().nullish(),
    inheritedModel: z.string().nullish(),
    inheritedOptions: z.array(SelectedOptionSchema).nullish(),
    providers: z.array(ProviderSchema),
  })
  .passthrough();

export type OptionValue = z.infer<typeof OptionValue>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type SelectedOption = z.infer<typeof SelectedOptionSchema>;

/**
 * Drivers for which T3 lists every current model in `orchestrator_capabilities`
 * (`FULL_CATALOG_DRIVERS` in T3's OrchestratorMcpService). For these,
 * `omittedModels` only counts legacy or user-hidden models.
 */
export const FULL_CATALOG_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "muse", "grok"]);

function parseOne(value: unknown, where: string): Capabilities {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error(`${where} is a string but not valid JSON. Pass the output of orchestrator_capabilities as-is.`);
    }
  }
  if (Array.isArray(v)) v = { providers: v };
  const parsed = CapabilitiesSchema.safeParse(v);
  if (!parsed.success) {
    throw new Error(`${where} does not look like orchestrator_capabilities output: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function isCapabilitiesLike(v: unknown): boolean {
  if (typeof v === "string") return v.trimStart().startsWith("{");
  return typeof v === "object" && v !== null && !Array.isArray(v) && "providers" in v;
}

/**
 * Accepts the capabilities as an object, a JSON string, a bare `providers`
 * array, or an array of several capabilities outputs (e.g. the full output
 * plus `search` results), which are merged with `mergeCapabilities`.
 */
export function parseCapabilities(input: unknown): Capabilities {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("capabilities is a string but not valid JSON. Pass the output of orchestrator_capabilities as-is.");
    }
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isCapabilitiesLike)) {
    return mergeCapabilities(value.map((v, i) => parseOne(v, `capabilities[${i}]`)));
  }
  return parseOne(value, "capabilities");
}

/**
 * Merge several capabilities outputs by `providerInstanceId`. The first output
 * that lists a provider gives its eligibility and options; models from later
 * outputs are added when their id is new. `omittedModels` is reduced by the
 * number of models added (an estimate: T3 does not say which ones it omitted).
 * Thread-level fields (inherited provider, model, options) come from the first
 * output that has them.
 */
export function mergeCapabilities(list: readonly Capabilities[]): Capabilities {
  if (list.length === 0) throw new Error("no capabilities to merge");
  const [first, ...rest] = list as [Capabilities, ...Capabilities[]];
  const out: Capabilities = structuredClone(first);
  for (const next of rest) {
    out.inheritedProviderInstanceId ??= next.inheritedProviderInstanceId;
    out.inheritedModel ??= next.inheritedModel;
    out.inheritedOptions ??= next.inheritedOptions;
    for (const p of next.providers) {
      const existing = out.providers.find((q) => q.providerInstanceId === p.providerInstanceId);
      if (!existing) {
        out.providers.push(structuredClone(p));
        continue;
      }
      const known = new Set(existing.models.map((m) => m.id));
      let added = 0;
      for (const m of p.models) {
        if (known.has(m.id)) continue;
        existing.models.push(structuredClone(m));
        known.add(m.id);
        added++;
      }
      if (added > 0 && existing.omittedModels !== undefined) {
        existing.omittedModels = Math.max(0, existing.omittedModels - added);
      }
      existing.mergedOutputs = (existing.mergedOutputs ?? 1) + 1;
      // A provider that became unusable in a later output is unusable.
      if (!p.canRunChildTask && existing.canRunChildTask) {
        existing.canRunChildTask = false;
        existing.constraints = [...(existing.constraints ?? []), ...(p.constraints ?? [])];
      }
    }
  }
  return out;
}

/** Driver kind of a provider; falls back to the instance id when T3 omits it. */
export function driverKindOf(provider: Provider): string {
  return provider.driverKind ?? provider.providerInstanceId;
}
