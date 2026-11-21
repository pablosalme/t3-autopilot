import type { Capabilities, Provider, SelectedOption } from "../capabilities.js";
import type { LoadedCatalog } from "../catalog.js";
import type { Policy } from "../policy.js";
import type { Candidate, RecommendText } from "../recommend.js";

/**
 * A host is the app the orchestrator runs in and starts children with: T3
 * Code and herdr. Each one has an adapter in this folder, listed in the registry
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
  /**
   * The agent catalog in force for this call, for hosts that do not list models: catalog/agents.yaml with the
   * user's catalog.yaml (in the data directory) merged onto it and checked against the policy's families, with
   * the warnings that gave. The files are read the first time an adapter reads this field, at most once per
   * call, so a host that never reads it (T3 Code) never reads them and an invalid catalog.yaml never fails its
   * calls. Reading it throws, naming the file, when the user's catalog is invalid.
   */
  readonly catalog: LoadedCatalog;
  /** The orchestrator's platform: the server is a stdio child of its agent CLI, on the same machine. */
  platform: NodeJS.Platform;
}

/**
 * The orchestrator itself, as recommend_model's `orchestrator` names it, for hosts whose payload does not (T3
 * Code's does, so its adapter ignores this): its agent as the host names it, and the model and options it runs.
 */
export interface Orchestrator {
  agent: string;
  model?: string;
  options?: SelectedOption[];
}

/** The arguments of a recommend_model call, besides the payload, that a host's catalog is built from. */
export interface CallOptions {
  orchestrator?: Orchestrator;
}

/** The arguments of a recommend_model call that a host's catalog is built from. */
export interface CallInput extends CallOptions {
  /** The host's own payload, exactly as the orchestrator passed it. */
  capabilities: unknown;
}

/** A host's payload turned into the canonical catalog the engine reads. */
export interface HostCatalog {
  capabilities: Capabilities;
  /** How many outputs the payload listed (`[full, search, ...]`); 0 for a single output. */
  outputs: number;
  /**
   * The orchestrator's session, when the payload names it (T3: its
   * `parentThreadId`): the capabilities are saved under it, so a later call
   * with `session` set to it gets them back after a restart.
   */
  session?: string;
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
 * How to start a candidate in a host that starts children with a command
 * (T3 Code takes the candidate itself as `delegate_task.target`, so it has
 * none). Every element is one argument: never a shell string, and the brief
 * never goes inside one.
 */
export interface Launch {
  /** supervised: the child reports back to the orchestrator when it is done or stuck; handoff: nothing comes back. */
  mode: "supervised" | "handoff";
  /** The host's agent id. */
  agent: string;
  /** Absent: the agent CLI's own default model. */
  model?: string;
  /** Absent: the CLI does not take one for this model. */
  effort?: string;
  /** The selection tokens, for any launch command of the host. */
  args: string[];
  /** The recommended command, one element per argument; whole elements such as `{briefFile}` are placeholders. */
  argv: string[];
  /** Commands to run next, when the agent does not take the brief at start. */
  then?: string[][];
  /** Notes for the platform or the CLI. */
  notes?: string[];
}

/**
 * What t3-autopilot needs to know about a host. The contract is described in
 * CONTRIBUTING.md ("Adding a host").
 */
export interface HostAdapter {
  readonly id: HostId;
  /** Its name for people: "T3 Code". */
  readonly name: string;
  /**
   * What the host's ids carry in the data files (unavailable.json,
   * subscriptions.yaml, log.jsonl, the policy's excludeProviders and
   * `instance:`): "" for T3 Code, whose ids are stored as they are, as in
   * 0.1; `<id>:` for any other host, so its `codex` never meets T3's.
   */
  readonly keyPrefix: "" | `${string}:`;
  /**
   * The file in the data directory where the server keeps this host's
   * capabilities for a restart, one entry per session:
   * `capabilities-cache.<id>.json`.
   */
  readonly cacheFile: string;
  /**
   * T3 Code only: `capabilities-cache.json`, the single entry 0.1 reads and
   * writes. It is kept as a copy of the host's last saved entry, and a call
   * that names no session reads it instead of the newest entry of `cacheFile`.
   */
  readonly legacyCacheFile?: string;
  /**
   * Whether the host sends its catalog in several outputs that the server
   * merges (`mergeCapabilities`, a list of outputs): T3's short lists plus
   * `search`.
   */
  readonly merges: boolean;
  /**
   * Whether calls must name the host: a payload of its shape in a call that names no host fails, asking for
   * `host`, unless the last recommend_model call of the process was for this host. For a host whose payload
   * is plain text that could be mistaken for something else (herdr's probe output).
   */
  readonly explicit?: boolean;
  readonly text: HostText;
  /** The instructions the user pastes into the orchestrator's CLAUDE.md / AGENTS.md: a `## ` title line, a blank line, the body. */
  readonly snippet: string;
  /**
   * How an orchestrator can tell it runs in this host, for `snippet --host all`, which lists one per host
   * before each host's instructions: "you have the `orchestrator_capabilities` tool".
   */
  readonly recognize: string;
  /** Whether a payload has this host's shape. */
  detect(payload: unknown): boolean;
  /** The canonical catalog for a call; throws, with a message that says what to pass, when the payload is not valid. */
  catalog(input: CallInput, ctx: HostContext): HostCatalog;
  /**
   * Optional. The catalog for a call that brings no payload when none is kept, built from files alone (herdr:
   * the agents listed in catalog.yaml); undefined when they give none, and the call then fails with
   * `text.noCatalog`. It is never kept, so edits to the files apply on the next call.
   */
  catalogFromFiles?(input: CallOptions, ctx: HostContext): HostCatalog | undefined;
  /**
   * Optional. The kept catalog rebuilt for a call that brings no payload, for a host whose catalog comes partly
   * from files (herdr: the programs found, with the agent catalog in force now), so edits to them apply without
   * passing the payload again, and so does the call's `orchestrator`. Absent: the kept catalog as it is.
   */
  refresh?(kept: Capabilities, input: CallOptions, ctx: HostContext): HostCatalog;
  /**
   * How to start a candidate, added to it as `launch`. Absent when the
   * candidate is enough (T3 Code). `provider` is the candidate's provider in
   * the call's catalog, with any field the adapter put on it. Throws to leave a
   * candidate out (a token that fails validation, say); the message goes into
   * `skipped`.
   */
  launch?(candidate: Candidate, ctx: HostContext, provider: Provider): Launch;
}
