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
