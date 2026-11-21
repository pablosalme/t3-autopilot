import type { Capabilities } from "../capabilities.js";
import type { Policy } from "../policy.js";
import type { RecommendText } from "../recommend.js";

/**
 * A host is the app the orchestrator runs in and starts children with: T3
 * Code today. Each one has an adapter in this folder, listed in the registry
 * (src/hosts/index.ts); the engine (recommend.ts, families.ts, effort.ts,
 * subscriptions.ts, unavailable.ts, log.ts) never knows which host it serves.
 */
export type HostId = string;

/** What an adapter may read while it builds a call's catalog. */
export interface HostContext {
  /** The data directory ($T3_AUTOPILOT_HOME or ~/.t3-autopilot). */
  dataDir: string;
  now: Date;
  /** The policy in force for this call (the default merged with the user's override). */
  policy: Policy;
  /** The orchestrator's platform: the server is a stdio child of its agent CLI, on the same machine. */
  platform: NodeJS.Platform;
}

/** The arguments of a recommend_model call that a host's catalog is built from. */
export interface CallInput {
  /** The host's own payload, exactly as the orchestrator passed it. */
  capabilities: unknown;
}

/** A host's payload turned into the canonical catalog the engine reads. */
export interface HostCatalog {
  capabilities: Capabilities;
  /** How many outputs the payload listed (`[full, search, ...]`); 0 for a single output. */
  outputs: number;
  /** Notes for the result's `warnings`. */
  notes: string[];
}

/** The phrases of the results that name the host or its tools. */
export interface HostText extends RecommendText {
  /** How to get the catalog, in a warning: "call orchestrator_capabilities and pass its full output as capabilities". */
  capture: string;
  /** The error when a call brings no capabilities and none are kept. */
  noCatalog: string;
  /** The warning when `mergeCapabilities` finds nothing kept to merge into (hosts that merge). */
  nothingToMerge: string;
  /** The last catalog, in a warning: "<id> is not in <lastCatalog>; check the providerInstanceId". */
  lastCatalog: string;
}

/**
 * What t3-autopilot needs to know about a host. The contract is described in
 * CONTRIBUTING.md ("Adding a host").
 */
export interface HostAdapter {
  readonly id: HostId;
  /** Its name for people: "T3 Code". */
  readonly name: string;
  /** The file in the data directory where the server keeps this host's capabilities for a restart. */
  readonly cacheFile: string;
  /**
   * Whether the host sends its catalog in several outputs that the server
   * merges (`mergeCapabilities`, a list of outputs): T3's short lists plus
   * `search`.
   */
  readonly merges: boolean;
  readonly text: HostText;
  /** The instructions the user pastes into the orchestrator's CLAUDE.md / AGENTS.md. */
  readonly snippet: string;
  /** Whether a payload has this host's shape. */
  detect(payload: unknown): boolean;
  /** The canonical catalog for a call; throws, with a message that says what to pass, when the payload is not valid. */
  catalog(input: CallInput, ctx: HostContext): HostCatalog;
}
