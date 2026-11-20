import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Capabilities, Model, Provider, SelectedOption } from "./capabilities.js";

/**
 * Orca (https://github.com/stablyai/orca) host support.
 *
 * Orca has no `orchestrator_capabilities`: `orca agent installed --json` lists
 * the agent CLIs that can start, but not their models. This module turns that
 * output, plus the models the user declares, into the same capabilities shape
 * T3 Code sends, so the policy, families and ranking work unchanged. Children
 * are started with `orca agent launch --agent <id> --model <id> --effort <level>`.
 */

/** `capabilities.host` value set on capabilities converted from Orca. */
export const ORCA_HOST = "orca";

/** Model id used for an agent with no declared models: launch without `--model` (the CLI's own default). */
export const ORCA_DEFAULT_MODEL = "default";

/** Orca agent ids whose CLI is the same as a T3 driver, so the driver's family patterns apply. */
export const ORCA_AGENT_DRIVERS: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  pi: "pi",
  kiro: "kiro",
};

/**
 * `--effort` levels each agent CLI takes, used when a declared model lists none.
 * An agent missing here gets no effort unless its models declare `efforts`.
 */
export const ORCA_DEFAULT_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

const DeclaredModelSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), efforts: z.array(z.string().min(1)).optional() }).strict(),
]);

/** Models per Orca agent id, best known first: `{ claude: [claude-opus-5-5, ...], codex: [{ id, efforts }] }`. */
export const OrcaModelsSchema = z.record(z.string(), z.array(DeclaredModelSchema));
export type OrcaModels = z.infer<typeof OrcaModelsSchema>;

const OrcaAgentSchema = z
  .object({ id: z.string().min(1), name: z.string().nullish(), default: z.boolean().optional() })
  .passthrough();

const OrcaInputSchema = z
  .object({
    agents: z.array(OrcaAgentSchema),
    orchestrator: z.object({ agent: z.string().min(1), model: z.string().min(1).optional() }).optional(),
    models: OrcaModelsSchema.optional(),
  })
  .passthrough();

export type OrcaInput = z.infer<typeof OrcaInputSchema>;

function asObject(value: unknown): Record<string, unknown> | undefined {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The Orca input in `value`, if it is one: the raw `orca agent installed --json`
 * output (`{ result: { agents } }`) or `{ agents, orchestrator?, models? }`,
 * as an object or a JSON string. `orchestrator` and `models` may sit next to
 * `result` in the raw output. Undefined for anything else (T3 capabilities).
 */
export function readOrcaInput(value: unknown): OrcaInput | undefined {
  const obj = asObject(value);
  if (!obj || "providers" in obj) return undefined;
  const result = asObject(obj.result);
  const agents = Array.isArray(obj.agents) ? obj.agents : Array.isArray(result?.agents) ? result.agents : undefined;
  if (agents === undefined) return undefined;
  const parsed = OrcaInputSchema.safeParse({ ...obj, agents });
  if (!parsed.success) {
    throw new Error(`capabilities looks like Orca input but is not valid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Models declared in `orca-models.yaml`; empty when the file does not exist. Throws on an invalid file. */
export function readOrcaModels(path: string): OrcaModels {
  if (!existsSync(path)) return {};
  const raw = parse(readFileSync(path, "utf8")) as unknown;
  if (raw == null) return {};
  const parsed = OrcaModelsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not valid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function toModel(declared: OrcaModels[string][number], agent: string): Model {
  const { id, efforts } = typeof declared === "string" ? { id: declared, efforts: undefined } : declared;
  const values = efforts ?? ORCA_DEFAULT_EFFORTS[agent];
  return values && values.length > 0 ? { id, options: [{ id: "effort", values: [...values] }] } : { id };
}

/**
 * Capabilities for an Orca input. Models come from the call's `models`, else
 * from `fileModels` (orca-models.yaml), per agent. An agent with none gets a
 * single `default` model, which the generic fallback can pick and which is
 * launched without `--model`.
 */
export function orcaToCapabilities(input: OrcaInput, fileModels: OrcaModels = {}): Capabilities {
  const providers: Provider[] = input.agents.map((agent) => {
    const declared = input.models?.[agent.id] ?? fileModels[agent.id] ?? [];
    const models = declared.length > 0 ? declared.map((m) => toModel(m, agent.id)) : [{ id: ORCA_DEFAULT_MODEL }];
    return {
      providerInstanceId: agent.id,
      driverKind: ORCA_AGENT_DRIVERS[agent.id] ?? agent.id,
      displayName: agent.name ?? null,
      models,
      omittedModels: 0,
      canRunChildTask: true,
    };
  });
  return {
    host: ORCA_HOST,
    inheritedProviderInstanceId: input.orchestrator?.agent ?? null,
    inheritedModel: input.orchestrator?.model ?? null,
    providers,
  };
}

/** Agents of an Orca input with no declared models (call or file). */
export function agentsWithoutModels(input: OrcaInput, fileModels: OrcaModels = {}): string[] {
  return input.agents.filter((a) => (input.models?.[a.id] ?? fileModels[a.id] ?? []).length === 0).map((a) => a.id);
}

export function isOrcaCapabilities(capabilities: Capabilities): boolean {
  return (capabilities as { host?: unknown }).host === ORCA_HOST;
}

export interface OrcaLaunch {
  agent: string;
  model?: string;
  effort?: string;
  /** The command to start the child; replace <task brief> with the child's prompt. */
  command: string;
}

/** How to start a candidate with Orca: `--model` only for a real model id, `--effort` only with `--model`. */
export function orcaLaunch(candidate: {
  providerInstanceId: string;
  model: string;
  options: SelectedOption[];
}): OrcaLaunch {
  const model = candidate.model === ORCA_DEFAULT_MODEL ? undefined : candidate.model;
  const effortOpt = candidate.options.find((o) => o.id === "effort");
  const effort = model && typeof effortOpt?.value === "string" ? effortOpt.value : undefined;
  const parts = ["orca agent launch", `--agent ${candidate.providerInstanceId}`];
  if (model) parts.push(`--model ${model}`);
  if (effort) parts.push(`--effort ${effort}`);
  parts.push('--prompt "<task brief>" --json');
  return {
    agent: candidate.providerInstanceId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    command: parts.join(" "),
  };
}
