import type { Capabilities, Provider } from "../capabilities.js";
import { DEFAULT_MODEL_ID } from "../catalog.js";
import type { Orchestrator } from "./types.js";

/** Helpers that the adapters of hosts built on the agent catalog (herdr, Orca) share. */

/** JSON text parsed; undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first line of a message, trimmed, without a final period: a message that goes on after it. */
const firstLine = (text: string) =>
  text
    .replace(/\n[\s\S]*/, "")
    .trim()
    .replace(/\.+$/, "");

/**
 * A payload that is a failed command's JSON output, `{ ok: false, ... }` (also as JSON text), with what its `error`
 * says: Orca's `{ code, message }` gives "runtime_unavailable: Could not read …", a plain string its first line.
 * Undefined for any other payload.
 */
export function failedOutput(payload: unknown): { code?: string; message?: string } | undefined {
  const value = typeof payload === "string" ? parseJson(payload) : payload;
  if (!isPlain(value) || value.ok !== false) return undefined;
  const error = isPlain(value.error) ? value.error : { message: value.error };
  const code = typeof error.code === "string" && error.code.trim() ? error.code.trim() : undefined;
  const message = typeof error.message === "string" ? firstLine(error.message) : "";
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

/** "a", "a and b", "a, b and c". */
export function list(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The orchestrator a kept catalog names. */
export function orchestratorOf(capabilities: Capabilities): Orchestrator | undefined {
  const agent = capabilities.inheritedProviderInstanceId;
  if (!agent) return undefined;
  return {
    agent,
    ...(capabilities.inheritedModel ? { model: capabilities.inheritedModel } : {}),
    ...(capabilities.inheritedOptions ? { options: capabilities.inheritedOptions } : {}),
  };
}

/** Whether a provider offers only the default model, with no policy family: the generic fallback's alone. */
export function onlyDefaultModel(provider: Provider): boolean {
  return provider.models.every((m) => m.id === DEFAULT_MODEL_ID && m.policyFamily === undefined);
}

/** The warning for agents of the catalog that offer only their default model. */
export function noModelsNote(agents: readonly string[], dataDir: string): string {
  return (
    `No models are declared for ${list(agents)} in the agent catalog, so only ${agents.length === 1 ? "its" : "their"} ` +
    "default model is offered, by the generic fallback with low confidence. List the models you use under " +
    `agents.<id>.models in catalog.yaml (in ${dataDir}).`
  );
}
