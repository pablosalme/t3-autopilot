import { CapabilitiesSchema } from "../src/capabilities.js";
import type { HostAdapter } from "../src/hosts/types.js";

/** An agent in the fake host's payload. */
export interface FakeAgent {
  id: string;
  /** The policy's driver kind; the agent's id by default. */
  driver?: string;
  models?: string[];
  /** false: installed but not usable. */
  ready?: boolean;
}

/** The fake host's payload: `{ fake: { agents, orchestrator? } }`. */
export interface FakePayload {
  fake: { agents: FakeAgent[]; orchestrator?: { agent: string; model?: string } };
}

export const fakePayload = (agents: FakeAgent[], orchestrator?: { agent: string; model?: string }): FakePayload => ({
  fake: { agents, ...(orchestrator ? { orchestrator } : {}) },
});

/**
 * A host that exists only in the tests, so the seam is exercised with
 * something that is not T3: every model takes a synthetic `effort` option,
 * and its texts are its own.
 */
export const fake: HostAdapter = {
  id: "fake",
  name: "Fake Host",
  keyPrefix: "fake:",
  cacheFile: "capabilities-cache.fake.json",
  merges: false,
  text: {
    noProviders: "fake-agents lists no agent.",
    enable: "Install an agent in Fake Host",
    listOrder: "Fake Host declares this one first",
    firstListed: "the first model Fake Host declares",
    capture: "run fake-agents and pass its output as capabilities",
    noCatalog: "No Fake Host catalog yet: run fake-agents and pass its output as `capabilities`.",
    nothingToMerge: "Fake Host never merges.",
    lastCatalog: "the last fake-agents output",
  },
  snippet: "## Model selection in Fake Host\n\nCall recommend_model with host: fake.\n",
  detect: (payload) => typeof payload === "object" && payload !== null && "fake" in payload,
  catalog: ({ capabilities }) => {
    const { agents, orchestrator } = (capabilities as FakePayload).fake;
    const parsed = CapabilitiesSchema.parse({
      inheritedProviderInstanceId: orchestrator?.agent ?? null,
      inheritedModel: orchestrator?.model ?? null,
      providers: agents.map((a) => ({
        providerInstanceId: a.id,
        driverKind: a.driver ?? a.id,
        models: (a.models ?? []).map((id) => ({ id, options: [{ id: "effort", values: ["low", "medium", "high"] }] })),
        canRunChildTask: a.ready ?? true,
        constraints: a.ready === false ? ["not signed in"] : [],
      })),
    });
    return { capabilities: parsed, outputs: 0, notes: [`Fake Host: ${agents.length} agents`] };
  },
};
