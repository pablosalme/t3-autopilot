import { z } from "zod";

/**
 * Schema for the output of T3 Code's `orchestrator_capabilities` tool.
 * Only the fields t3-autopilot reads are declared; everything else passes through.
 */
const OptionValue = z.union([z.string(), z.number(), z.boolean()]);

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
    label: z.string().optional(),
    options: z.array(ModelOptionSchema).optional(),
  })
  .passthrough();

export const ProviderSchema = z
  .object({
    providerInstanceId: z.string(),
    driverKind: z.string().optional(),
    displayName: z.string().optional(),
    models: z.array(ModelSchema).default([]),
    canRunChildTask: z.boolean().default(false),
    canRunCrossProviderChildTask: z.boolean().optional(),
    constraints: z.array(z.string()).optional(),
  })
  .passthrough();

export const SelectedOptionSchema = z.object({ id: z.string(), value: OptionValue });

export const CapabilitiesSchema = z
  .object({
    inheritedProviderInstanceId: z.string().optional(),
    inheritedModel: z.string().optional(),
    inheritedOptions: z.array(SelectedOptionSchema).optional(),
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
 * Accepts the capabilities as an object, as a JSON string, or as a bare
 * `providers` array, and validates them.
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
  if (Array.isArray(value)) value = { providers: value };
  const parsed = CapabilitiesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`capabilities does not look like orchestrator_capabilities output: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Driver kind of a provider; falls back to the instance id when T3 omits it. */
export function driverKindOf(provider: Provider): string {
  return provider.driverKind ?? provider.providerInstanceId;
}
