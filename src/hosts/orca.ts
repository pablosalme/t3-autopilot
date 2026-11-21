import { CapabilitiesSchema, type Model, type Provider } from "../capabilities.js";
import { type AgentCatalog, agentProvider, agentView, DEFAULT_MODEL_ID, isToken, resolveAgent } from "../catalog.js";
import type { Candidate } from "../recommend.js";
import { list, noModelsNote, onlyDefaultModel, orchestratorOf, parseJson } from "./common.js";
import type { CallOptions, HostAdapter, HostCatalog, HostContext, Launch, Orchestrator } from "./types.js";

/**
 * Orca (orca.dev), an agent IDE whose `orca` command line drives the running app. Orca says which agent CLIs are
 * installed and turned on (`orca agent installed --json`) but not their models, so the catalog comes from that list
 * and t3-autopilot's agent catalog (catalog/agents.yaml plus the user's catalog.yaml, with its `hosts.orca`
 * overrides). A child is a supervised worker: `orca orchestration worker-start --agent <id> [--model <id>
 * [--effort <level>]] --spec-file <file>` reads the brief from a file, and Orca wakes the orchestrator when the
 * worker reports back with `worker_done`, asks, or stops. Orca checks the model and effort at start (in its
 * source, src/shared/agent-launch/choices/agent-launch-model-preferences.ts): an effort needs a model, Pi takes
 * only a provider/id model, OpenCode takes one only in an existing worktree, and only some agents take one at all.
 * Read in Orca's source at commit e955bff; docs/hosts/orca.md says what was run for real.
 */

/** What the orchestrator runs to list Orca's agents, with Orca's command in place of `orca`. */
export const ORCA_DISCOVERY = "orca agent installed --environment local --json";

/** Placeholder of a launch command: the path of the brief file, a whole argument the orchestrator replaces. */
export const BRIEF_FILE = "{briefFile}";

/**
 * The Orca agents whose worker-start takes `--model`: the ones whose launch catalog in Orca supports worker launch
 * preferences (`supportsWorkerLaunchPreferences` in src/shared/agent-session/options/catalog-providers/, with
 * OpenCode's and Pi's launch catalogs). Orca starts every other agent, opencode2 among them, with the model set in
 * its own config, and refuses `--model` for it.
 */
export const ORCA_MODEL_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "grok",
  "muse",
  "pi",
  "opencode",
  "omp",
  "codebuddy",
]);

/** A provider's field (kept in the cache with it) for the id Orca's `--agent` takes, such as `opencode2`. */
const AGENT = "agent";

/** An Orca agent id (`claude`, `opencode2`, `claude-agent-teams`), which is also an id the engine can key state with. */
const AGENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An agent of Orca's list: an object with a string `id`, and no `providerInstanceId`, so never a T3 provider. */
const isAgentItem = (value: unknown): boolean =>
  isPlain(value) && typeof value.id === "string" && !("providerInstanceId" in value) && !("providers" in value);

/** A payload as a value: JSON text parsed (undefined when it is text but not JSON), anything else as it is. */
const payloadValue = (payload: unknown): unknown => (typeof payload === "string" ? parseJson(payload) : payload);

/** Pi's models in Orca: `provider/id` (`isPiModelOptionId` in Orca's Pi catalog). */
function isProviderModel(id: string): boolean {
  const slash = id.indexOf("/");
  return slash > 0 && slash < id.length - 1;
}

/** "its" or "their". */
const its = (items: readonly unknown[]) => (items.length === 1 ? "its" : "their");

/** An agent in `orca agent installed --json`. */
export interface InstalledAgent {
  /** What Orca's `--agent` takes. */
  id: string;
  /** Orca's name for it ("Claude", "OpenCode 2"). */
  name?: string;
}

/** What a payload says about Orca's agents. */
export interface Installed {
  agents: InstalledAgent[];
  /** What is not an agent with a valid id. */
  ignored: string[];
}

/** A value, short, for a message. */
function short(value: unknown): string {
  const text = typeof value === "string" ? `"${value}"` : (JSON.stringify(value) ?? String(value));
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * The agents in a payload: the output of `orca agent installed --json` (`{ ok: true, result: { agents } }`), its
 * `result` (`{ agents }`) or the `agents` list itself, also as JSON text. Throws, saying what to pass, for Orca's
 * error output (`{ ok: false, error }`) and for any other shape.
 */
export function readInstalled(payload: unknown): Installed {
  const value = payloadValue(payload);
  if (isPlain(value) && value.ok === false) {
    const error = isPlain(value.error) ? value.error : {};
    const code = typeof error.code === "string" ? error.code : "an error";
    // Its first line, without a final period: the message goes on after it.
    const message =
      typeof error.message === "string"
        ? error.message
            .replace(/\n[\s\S]*/, "")
            .trim()
            .replace(/\.+$/, "")
        : "";
    throw new Error(
      `${ORCA_DISCOVERY} failed with ${code}${message ? `: ${message}` : ""}. Pass its output once it succeeds.`,
    );
  }
  const holder = isPlain(value) && isPlain(value.result) ? value.result : value;
  const items = Array.isArray(holder) ? holder : isPlain(holder) ? holder.agents : undefined;
  if (!Array.isArray(items)) {
    const got =
      typeof payload === "string" && value === undefined
        ? "text that is not JSON"
        : isPlain(value)
          ? "an object without result.agents"
          : value === null
            ? "null"
            : typeof value;
    throw new Error(
      `capabilities for Orca is the output of ${ORCA_DISCOVERY}, exactly as printed (or its list of agents); got ${got}.`,
    );
  }
  const agents: InstalledAgent[] = [];
  const ignored: string[] = [];
  for (const item of items) {
    const id = isPlain(item) && typeof item.id === "string" ? item.id.trim() : undefined;
    if (id === undefined || !AGENT_ID.test(id)) {
      ignored.push(id === undefined ? short(item) : short(id));
      continue;
    }
    if (agents.some((a) => a.id === id)) continue;
    const name = isPlain(item) && typeof item.name === "string" ? item.name.trim().slice(0, 100) : "";
    agents.push(name ? { id, name } : { id });
  }
  return { agents, ignored };
}

/** A model without its options: the default model in Orca, which starts with no `--model`, so with no `--effort`. */
function withoutOptions(model: Model): Model {
  const { options: _options, ...rest } = model;
  return rest;
}

/**
 * The canonical catalog for Orca's agents: one provider per agent of the catalog, its instance id the catalog's
 * id for it (`opencode` for Orca's `opencode2`), with the id `--agent` takes kept on it, the models the agent
 * catalog lists that Orca can start it with, and the orchestrator's agent and model.
 */
function buildCatalog(agents: readonly InstalledAgent[], orchestrator: Orchestrator | undefined, ctx: HostContext) {
  const { catalog, warnings } = ctx.catalog;
  const notes = [...warnings];
  // One provider per agent of the catalog. When Orca has two ids for it (opencode and opencode2), the one that is
  // the catalog's own id starts it.
  const found = new Map<string, InstalledAgent>();
  for (const agent of agents) {
    const id = resolveAgent(catalog, "orca", agent.id) ?? agent.id;
    const had = found.get(id);
    if (had === undefined || (had.id !== id && agent.id === id)) found.set(id, agent);
  }
  const unknown: string[] = [];
  const noModel: string[] = [];
  const notProviderId: string[] = [];
  const providers = [...found].map(([id, agent]) => {
    const known = Object.hasOwn(catalog.agents, id);
    if (!known) unknown.push(id);
    const base = agentProvider(catalog, "orca", id);
    let models = base.models;
    if (!ORCA_MODEL_AGENTS.has(agent.id)) {
      // Orca refuses --model for this agent: only the default model, the one set in its own config.
      if (models.some((m) => m.id !== DEFAULT_MODEL_ID)) noModel.push(agent.id);
      models = [models.find((m) => m.id === DEFAULT_MODEL_ID) ?? { id: DEFAULT_MODEL_ID }];
    } else if (agent.id === "pi") {
      const valid = models.filter((m) => m.id === DEFAULT_MODEL_ID || isProviderModel(m.id));
      notProviderId.push(...models.filter((m) => !valid.includes(m)).map((m) => `"${m.id}"`));
      models = valid.length > 0 ? valid : [{ id: DEFAULT_MODEL_ID }];
    }
    // Orca takes an effort only with --model, so the default model, started without one, takes none.
    models = models.map((m) => (m.id === DEFAULT_MODEL_ID ? withoutOptions(m) : m));
    return { ...base, ...(!known && agent.name ? { displayName: agent.name } : {}), models, [AGENT]: agent.id };
  });

  let inherited: string | undefined;
  let model: string | undefined;
  if (orchestrator !== undefined) {
    if (AGENT_ID.test(orchestrator.agent)) {
      inherited = resolveAgent(catalog, "orca", orchestrator.agent) ?? orchestrator.agent;
    } else notes.push(`orchestrator.agent "${orchestrator.agent}" is not an Orca agent id, so it is ignored.`);
    if (orchestrator.model !== undefined && isToken(orchestrator.model)) model = orchestrator.model;
    else if (orchestrator.model !== undefined) {
      notes.push(`orchestrator.model "${orchestrator.model}" is not one command-line word, so it is ignored.`);
    }
  }
  const capabilities = CapabilitiesSchema.parse({
    inheritedProviderInstanceId: inherited ?? null,
    inheritedModel: inherited !== undefined ? (model ?? null) : null,
    inheritedOptions: inherited !== undefined ? (orchestrator?.options ?? null) : null,
    providers,
  });

  if (unknown.length) {
    notes.push(
      `${list(unknown)} ${unknown.length === 1 ? "is" : "are"} not in the agent catalog: offered with ${its(unknown)} ` +
        `default model only, the one set in ${its(unknown)} own config. Describe ${unknown.length === 1 ? "it" : "them"} ` +
        "in catalog.yaml (driver, models) to do better.",
    );
  }
  if (noModel.length) {
    notes.push(
      `Orca starts ${list(noModel)} with the model set in ${its(noModel)} own config (worker-start takes no --model ` +
        `for ${noModel.length === 1 ? "it" : "them"}), so the models the agent catalog lists are not offered.`,
    );
  }
  if (notProviderId.length) {
    notes.push(
      `Orca starts Pi only with a provider/id model, such as openai/gpt-9.1-sol, so ${list(notProviderId)} ` +
        `${notProviderId.length === 1 ? "is" : "are"} not offered.`,
    );
  }
  const bare = providers
    .filter((p) => !unknown.includes(p.providerInstanceId) && ORCA_MODEL_AGENTS.has(p[AGENT]))
    .filter((p) => !(p[AGENT] === "pi" && notProviderId.length))
    .filter((p) => agentView(catalog, "orca", p.providerInstanceId).selectsModel && onlyDefaultModel(p))
    .map((p) => p.providerInstanceId);
  if (bare.length) notes.push(noModelsNote(bare, ctx.dataDir));
  return { capabilities, notes };
}

/** The payload's notes: what it held that is not an agent. */
function installedNotes(installed: Installed): string[] {
  return installed.ignored.length
    ? [`Ignored in capabilities: ${list(installed.ignored)} (not an Orca agent id).`]
    : [];
}

/** Whether the agent catalog gives an agent efforts, which Orca passes only with a model. */
function hasEfforts(catalog: AgentCatalog, id: string): boolean {
  const view = agentView(catalog, "orca", id);
  return view.efforts.length > 0 || view.models.some((m) => (m.efforts?.length ?? 0) > 0);
}

/**
 * How to start a candidate in Orca: `orca orchestration worker-start --environment local --agent <id>
 * [--model <id> [--effort <level>]] --worktree current --spec-file {briefFile} --json`, the recipe of Orca's own
 * orchestration guide with the brief in a file. Throws for a model Orca would refuse, so the candidate goes to
 * `skipped`.
 */
function launch(candidate: Candidate, ctx: HostContext, provider: Provider): Launch {
  const { catalog } = ctx.catalog;
  const id = candidate.providerInstanceId;
  const kept = provider[AGENT];
  const agent = typeof kept === "string" ? kept : id;
  if (!AGENT_ID.test(agent)) throw new Error(`"${agent}" is not an Orca agent id.`);
  const model = candidate.model === DEFAULT_MODEL_ID ? undefined : candidate.model;
  if (model !== undefined) {
    if (!isToken(model)) {
      throw new Error(`model "${model}" is not one command-line word (letters, digits, . _ : / @ + = , [ ] -).`);
    }
    if (!ORCA_MODEL_AGENTS.has(agent) || !agentView(catalog, "orca", id).selectsModel) {
      throw new Error(
        `Orca starts ${agent} with the model set in its own config: worker-start takes no --model for it.`,
      );
    }
    if (agent === "pi" && !isProviderModel(model)) {
      throw new Error("Orca starts pi only with a provider/id model, such as openai/gpt-9.1-sol.");
    }
  }
  const chosen = candidate.options.find((o) => o.id === "effort");
  const wanted = typeof chosen?.value === "string" ? chosen.value : undefined;
  if (wanted !== undefined && !isToken(wanted)) throw new Error(`effort "${wanted}" is not one command-line word.`);
  const effort = model === undefined ? undefined : wanted;
  const notes: string[] = [];
  if (model === undefined && (wanted !== undefined || hasEfforts(catalog, id))) {
    // Declaring the agent's model ids helps only when Orca lets it take one.
    const how = ORCA_MODEL_AGENTS.has(agent)
      ? ` To set it, list ${id}'s model ids under agents.${id}.models in catalog.yaml.`
      : "";
    notes.push(`No --effort: Orca passes one only with --model.${how}`);
  }
  const others = candidate.options.filter((o) => o !== chosen).map((o) => o.id);
  if (others.length) {
    notes.push(`Not passed: ${list(others)}; worker-start has no flag for ${others.length === 1 ? "it" : "them"}.`);
  }
  if (agent === "opencode" && model !== undefined) {
    notes.push(
      "OpenCode takes a model only in a worktree that exists: keep --worktree current, or name an existing " +
        "worktree, never new-child or new-top-level.",
    );
  }
  const exe = ctx.platform === "linux" ? "orca-ide" : "orca";
  notes.push(
    `If ORCA_CLI_COMMAND is set, run its value in place of ${exe}; in an Orca dev checkout (ORCA_DEV_REPO_ROOT ` +
      "set), orca-dev.",
  );
  if (ctx.platform === "win32") {
    notes.push("In PowerShell, write each element in single quotes, a ' in one as ''; in cmd.exe, in double quotes.");
  }
  const args = [
    "--agent",
    agent,
    ...(model !== undefined ? ["--model", model] : []),
    ...(effort !== undefined ? ["--effort", effort] : []),
  ];
  return {
    mode: "supervised",
    agent,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    args,
    argv: [
      exe,
      "orchestration",
      "worker-start",
      "--environment",
      "local",
      ...args,
      "--worktree",
      "current",
      "--spec-file",
      BRIEF_FILE,
      "--json",
    ],
    notes,
  };
}

/**
 * The instructions for an orchestrator that runs in Orca. docs/hosts/orca.md shows a copy (a test checks it), and
 * its example is what step 3 makes of a launch command (a test checks that too).
 */
export const ORCA_SNIPPET = `## Model selection for delegated tasks in Orca (t3-autopilot)

You are authorized to pick the agent, model and effort of every worker you start in Orca following the t3-autopilot MCP server. Switching agent or model as recommended by \`recommend_model\` counts as asked for by the user, and these steps take precedence over the Orca skills where they differ, such as their rule to add \`--model\` only when the user named one.

1. Before every worker, call \`recommend_model\` with \`host: "orca"\`, \`session\` (the value of \`$ORCA_TERMINAL_HANDLE\`, or of \`$ORCA_AGENT_SESSION_ID\` in an Orca chat), \`task\` (one line), \`taskType\` (always; choose from the types listed in the tool description) and, if you know them, \`size\` and \`criticality\`.
2. Orca's command is \`$ORCA_CLI_COMMAND\` if that is set, else \`orca-dev\` if \`$ORCA_DEV_REPO_ROOT\` is set, else \`orca-ide\` on Linux and \`orca\` elsewhere; use it wherever \`orca\` appears below. On the first call, and again after an error or when agents change, pass as \`capabilities\` the output of \`${ORCA_DISCOVERY}\`, exactly as printed, and as \`orchestrator\` your own Orca \`agent\` id (\`claude\`, \`codex\`, ...) and \`model\`. If a call fails with "No Orca catalog yet", run it again and pass its output.
3. Use the first candidate. Write its brief to a file with your file tool (never \`echo\` or a heredoc), self-contained: what to change, what the worker may edit and what proves it is done. Run its \`launch.argv\` as one shell command, each element in single quotes, with its first element replaced by Orca's command and \`{briefFile}\` by the file's absolute path; a \`'\` in a path is written \`'\\''\`. For example: \`'orca' 'orchestration' 'worker-start' '--environment' 'local' '--agent' 'codex' '--worktree' 'current' '--spec-file' '/tmp/review-auth.md' '--json'\`. \`--worktree current\` runs the worker in your workspace; when its changes would clash with yours or another worker's, write \`new-child\` instead and add \`--name <short-name>\`. Follow \`launch.notes\`. Then end your turn: Orca wakes you when the worker reports with \`worker_done\`, asks or stops; never poll. If it has \`sameAsOrchestrator: true\`, your native subagent tool works too.
4. If \`worker-start\` fails, or the worker stops at once (an \`escalation\`), because of a usage limit or its plan, call \`mark_unavailable\` with \`host: "orca"\`, its \`providerInstanceId\`, its \`model\` (omit it if the whole agent is out), a short \`reason\` and \`until\` if you know when the limit resets; then use the next candidate. For any other failure, do what Orca prints, and never rerun the same command on your own.
5. Tell the user in one line which agent and model you picked, and why (the candidate's \`reason\`).
6. If \`recommend_model\` returns no candidate or fails, start the worker on your own agent without \`--model\`, and say so. If the user names an agent or model for a task, use theirs instead.
7. Right after starting the worker, call \`log_delegation\` with \`host: "orca"\`, the \`taskType\`, \`providerInstanceId\`, \`model\` and \`options\` you used, \`recommendedRank\` (1-based rank of the candidate, or null if you chose something else) and \`childThreadId\` (the \`dispatchId\` that \`worker-start\` printed); keep the \`delegationId\`. When its \`worker_done\` arrives, review the result (\`orca orchestration worker-read --dispatch <dispatchId>\` shows its output) and call \`log_outcome\` with that \`delegationId\`, \`outcome\` (\`success\`, \`corrected\` or \`failure\`) and a short \`note\`.
8. If the result has \`setupNeeded\`, ask the user its questions for every agent listed, all at once, without holding up the current task, and save each answer with \`set_subscription\` (\`host: "orca"\`). If a warning says an agent has no models declared, tell the user once where to list them; if one says a candidate costs extra or is outside its subscription profile, ask the user before starting it.
`;

/** Orca's adapter: see the comment at the top of this file. */
export const orca: HostAdapter = {
  id: "orca",
  name: "Orca",
  keyPrefix: "orca:",
  cacheFile: "capabilities-cache.orca.json",
  merges: false,
  text: {
    noProviders:
      `${ORCA_DISCOVERY} lists no agent CLI that is installed and turned on, so there is nothing to recommend. ` +
      "Install one, or turn it on in Orca's Settings → Agents, then pass the output again.",
    enable: "Install or turn on another agent in Orca (Settings → Agents)",
    listOrder: "the agent catalog lists this one first",
    firstListed: "the first model the agent catalog lists for it",
    capture: `pass host: "orca" and, as capabilities, the output of ${ORCA_DISCOVERY}`,
    noCatalog: `No Orca catalog yet: pass host: "orca" and, as \`capabilities\`, the output of \`${ORCA_DISCOVERY}\` (later calls can omit it).`,
    nothingToMerge: "Orca sends its whole catalog in one output, so there is nothing to merge.",
    lastCatalog: "the last orca agent installed output",
  },
  snippet: ORCA_SNIPPET,
  recognize:
    "`ORCA_TERMINAL_HANDLE` or `ORCA_AGENT_SESSION_ID` is set in your environment (you run in an Orca terminal or chat)",
  /**
   * Orca's output, also as JSON text: an object with `ok` and a `result` or an `error` (the error output too, so
   * the call says why it failed), its `result` (`{ agents }`), or the agents list itself. T3 Code's adapter, first
   * in the registry, leaves such a list to Orca: every T3 provider has a `providerInstanceId`.
   */
  detect: (payload) => {
    const value = payloadValue(payload);
    if (Array.isArray(value)) return value.every(isAgentItem);
    if (!isPlain(value)) return false;
    if (typeof value.ok === "boolean") return "result" in value || "error" in value;
    return Array.isArray(value.agents);
  },
  catalog: ({ capabilities, orchestrator }, ctx): HostCatalog => {
    const installed = readInstalled(capabilities);
    const built = buildCatalog(installed.agents, orchestrator, ctx);
    return { capabilities: built.capabilities, outputs: 0, notes: [...built.notes, ...installedNotes(installed)] };
  },
  refresh: (kept, { orchestrator }: CallOptions, ctx) => {
    const agents = kept.providers.map((p): InstalledAgent => {
      const agent = p[AGENT];
      return {
        id: typeof agent === "string" ? agent : p.providerInstanceId,
        ...(typeof p.displayName === "string" ? { name: p.displayName } : {}),
      };
    });
    return { ...buildCatalog(agents, orchestrator ?? orchestratorOf(kept), ctx), outputs: 0 };
  },
  launch,
};
