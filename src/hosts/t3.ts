import { parseCapabilitiesInput } from "../capabilities.js";
import { DATA_FILES } from "../paths.js";
import { DEFAULT_RECOMMEND_TEXT } from "../recommend.js";
import { INSTRUCTIONS_SNIPPET } from "../snippet.js";
import type { HostAdapter } from "./types.js";

/**
 * T3 Code's payload: the output of `orchestrator_capabilities` (an object
 * with `providers`), a bare `providers` array, or a list of outputs; any of
 * them also as JSON text.
 */
function looksLikeT3(payload: unknown): boolean {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return true;
  return typeof value === "object" && value !== null && "providers" in value;
}

/**
 * T3 Code: the orchestrator passes the output of its `orchestrator_capabilities`
 * tool, which is already the canonical catalog, and starts a child with
 * `delegate_task`, taking a candidate as its `target`. T3 lists at most 8
 * models of some providers and finds the rest with `search`, so its outputs
 * are merged.
 */
export const t3: HostAdapter = {
  id: "t3",
  name: "T3 Code",
  keyPrefix: "",
  cacheFile: "capabilities-cache.t3.json",
  legacyCacheFile: DATA_FILES.capabilitiesCache,
  merges: true,
  text: {
    ...DEFAULT_RECOMMEND_TEXT,
    capture: "call orchestrator_capabilities and pass its full output as capabilities",
    noCatalog:
      "No capabilities yet: call orchestrator_capabilities and pass its full output as `capabilities` (later calls can omit it).",
    nothingToMerge:
      "mergeCapabilities: there were no earlier capabilities to merge into (first call, or the server restarted and " +
      "its saved copy is missing or expired), so only this output was used and it was not kept. If it is a search " +
      "output, pass the full orchestrator_capabilities output too, as capabilities: [full, search].",
    lastCatalog: "the last orchestrator_capabilities output",
  },
  snippet: INSTRUCTIONS_SNIPPET,
  recognize: "you have the `orchestrator_capabilities` tool",
  detect: looksLikeT3,
  catalog: ({ capabilities }) => {
    const parsed = parseCapabilitiesInput(capabilities);
    // `policyFamily` ties a model of the agent catalog to a policy family (families.ts). A T3 model never carries
    // one; were T3 to send a field with that name, it must not change what T3 orchestrators get.
    for (const provider of parsed.capabilities.providers) {
      for (const model of provider.models) delete (model as { policyFamily?: unknown }).policyFamily;
    }
    // The orchestrator's own thread: T3 sends it in every output (null outside a thread).
    const thread = (parsed.capabilities as { parentThreadId?: unknown }).parentThreadId;
    return { ...parsed, ...(typeof thread === "string" && thread !== "" ? { session: thread } : {}), notes: [] };
  },
};
