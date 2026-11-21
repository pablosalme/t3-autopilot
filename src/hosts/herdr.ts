import { type Capabilities, CapabilitiesSchema, type Provider } from "../capabilities.js";
import { agentCommand, agentProvider, BRIEF, DEFAULT_MODEL_ID, isToken, resolveAgent } from "../catalog.js";
import type { Candidate } from "../recommend.js";
import type { CallOptions, HostAdapter, HostCatalog, HostContext, Launch, Orchestrator } from "./types.js";

/**
 * herdr, through herdr-core's `hc` (also what the herdr desktop app runs on;
 * the older `herdr` terminal multiplexer is not covered). hc starts programs
 * in terminals that stay alive and knows nothing about providers or models, so
 * the catalog comes from t3-autopilot's agent catalog (catalog/agents.yaml plus
 * the user's catalog.yaml) and from a probe of the programs on PATH that the
 * orchestrator runs and passes as `capabilities`. A child starts with
 * `hc run --bg --name <name> --cwd <dir> <program> <flags> <brief>`, and
 * reports back with `hc send $HC_TERMINAL_ID`; an agent that takes no brief at
 * start gets it with `hc wait` and `hc send` (herdr-core's SKILL.md).
 */

/** The programs the herdr snippet probes for: every `exe` and executable alias of the built-in agent catalog. */
export const HERDR_PROBE_PROGRAMS = [
  "claude",
  "codex",
  "cursor-agent",
  "grok",
  "opencode",
  "opencode2",
  "pi",
  "agy",
  "muse",
  "kiro-cli",
  "gemini",
] as const;

/**
 * What the orchestrator runs to find the agent CLIs: one `command -v` per program, which prints the path of each
 * one found and nothing for the others. A loop, because `command -v a b` stops at the first missing name in some
 * shells (dash, Debian's sh); through `sh`, so it runs the same from any shell; and ending in `true`, so a
 * missing last program does not make it fail.
 */
export const HERDR_PROBE = `sh -c 'for a in ${HERDR_PROBE_PROGRAMS.join(" ")}; do command -v "$a"; done; true'`;

/** Placeholders of a launch command: each one is a whole argument the orchestrator replaces. */
const NAME = "{name}";
const CWD = "{cwd}";

/** A provider's field (kept in the cache with it) for the program the probe found, such as `cursor-agent`. */
const PROGRAM = "program";

/** An agent id the engine can key state with, for an agent the catalog does not know. */
const AGENT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** An absolute path, POSIX or Windows. */
const PATH_LIKE = /^(?:\/|[A-Za-z]:[\\/])/;

/** `alias claude='…'`: what bash and zsh print for an alias. */
const ALIAS_LINE = /^alias\s+([^=\s]+)=/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The program a path names: its last part, without a Windows `.exe`. */
function programOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return base.replace(/\.exe$/i, "");
}

/**
 * Whether a text is what the probe prints: one line per program found, each an absolute path or an alias, and
 * nothing else. A name alone is not enough to tell it from other text.
 */
function looksLikeProbe(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => PATH_LIKE.test(line) || ALIAS_LINE.test(line));
}

/** What a payload says about the programs on PATH. */
interface Probe {
  /** Program names, in order, without repeats. */
  names: string[];
  /** What is not a program name or path. */
  ignored: string[];
}

/**
 * The programs in a payload: the probe's output (absolute paths, alias lines), or program names, as text (one
 * per line, or separated by spaces or commas) or as a list (names or paths), also as JSON text. Throws, saying
 * what to pass, for any other shape.
 */
export function readProbe(payload: unknown): Probe {
  const json = typeof payload === "string" ? parseJson(payload) : undefined;
  const value = isStringList(json) ? json : payload;
  let words: string[];
  if (typeof value === "string") {
    words = value.split(/\r?\n/).flatMap((raw) => {
      const line = raw.trim();
      const alias = ALIAS_LINE.exec(line)?.[1];
      if (alias !== undefined) return [alias];
      // A path may have spaces; names on one line are separated by spaces or commas.
      return PATH_LIKE.test(line) ? [line] : line.split(/[\s,]+/).filter((w) => w !== "");
    });
  } else if (isStringList(value)) {
    words = value.map((item) => item.trim()).filter((item) => item !== "");
  } else {
    throw new Error(
      `capabilities for herdr is the output of ${HERDR_PROBE} as text, or a list of program names ` +
        `(["claude", "codex"]); got ${Array.isArray(value) ? "a list with an item that is not a string" : typeof value}.`,
    );
  }
  const names: string[] = [];
  const ignored: string[] = [];
  for (const word of words) {
    const name = PATH_LIKE.test(word) ? programOf(word) : word;
    if (!isToken(name)) ignored.push(word);
    else if (!names.includes(name)) names.push(name);
  }
  return { names, ignored };
}

/** "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The orchestrator a kept catalog names. */
function orchestratorOf(capabilities: Capabilities): Orchestrator | undefined {
  const agent = capabilities.inheritedProviderInstanceId;
  if (!agent) return undefined;
  return {
    agent,
    ...(capabilities.inheritedModel ? { model: capabilities.inheritedModel } : {}),
    ...(capabilities.inheritedOptions ? { options: capabilities.inheritedOptions } : {}),
  };
}

/**
 * The canonical catalog for the programs found: one provider per agent, its instance id the catalog's id for it
 * (`cursor` for `cursor-agent`), with the program to run kept on it, and the orchestrator's agent and model.
 */
function buildCatalog(programs: readonly string[], orchestrator: Orchestrator | undefined, ctx: HostContext) {
  const { catalog, warnings } = ctx.catalog;
  const notes = [...warnings];
  const found = new Map<string, string>();
  const unknown: string[] = [];
  const ignored: string[] = [];
  for (const name of programs) {
    const id = resolveAgent(catalog, "herdr", name);
    if (id === undefined) {
      if (!AGENT_ID.test(name)) ignored.push(name);
      else if (!found.has(name)) {
        found.set(name, name);
        unknown.push(name);
      }
      continue;
    }
    const exe = catalog.agents[id]?.exe ?? id;
    // The id names the agent, not a program: its exe runs. Another name found is the program, and the exe wins
    // when both are found.
    const program = name === id ? exe : name;
    const had = found.get(id);
    if (had === undefined || (had !== exe && program === exe)) found.set(id, program);
  }
  const providers = [...found].map(([id, program]) => ({ ...agentProvider(catalog, "herdr", id), [PROGRAM]: program }));

  let inherited: string | undefined;
  let model: string | undefined;
  if (orchestrator !== undefined) {
    if (isToken(orchestrator.agent))
      inherited = resolveAgent(catalog, "herdr", orchestrator.agent) ?? orchestrator.agent;
    else notes.push(`orchestrator.agent "${orchestrator.agent}" is not a program name, so it is ignored.`);
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

  if (ignored.length) notes.push(`${list(ignored.map((n) => `"${n}"`))}: not an agent id, so ignored.`);
  if (unknown.length) {
    notes.push(
      `${list(unknown)} ${unknown.length === 1 ? "is" : "are"} not in the agent catalog: offered with the default ` +
        "model only, started with no flags and sent the brief once ready. Describe it in catalog.yaml (exe, models, " +
        "flags, prompt) to do better.",
    );
  }
  const bare = providers
    .filter((p) => !unknown.includes(p.providerInstanceId))
    .filter((p) => p.models.every((m) => m.id === DEFAULT_MODEL_ID && m.policyFamily === undefined))
    .map((p) => p.providerInstanceId);
  if (bare.length) {
    notes.push(
      `No models are declared for ${list(bare)} in the agent catalog, so only ${bare.length === 1 ? "its" : "their"} ` +
        "default model is offered, by the generic fallback with low confidence. List the models you use under " +
        `agents.<id>.models in catalog.yaml (in ${ctx.dataDir}).`,
    );
  }
  return { capabilities, notes };
}

/** The probe's notes: what it held that is not a program. */
function probeNotes(probe: Probe): string[] {
  return probe.ignored.length
    ? [`Ignored in capabilities: ${list(probe.ignored.map((w) => `"${w}"`))} (not a program path or name).`]
    : [];
}

/** How many words at the end of an agent's command carry the brief. */
function briefWords(ctx: HostContext, agent: string): number {
  const prompt = ctx.catalog.catalog.agents[agent]?.prompt ?? "send";
  return prompt === "send" ? 0 : prompt === "positional" ? 1 : prompt.length;
}

/**
 * How to start a candidate with hc: `hc run --bg --name {name} --cwd {cwd}` and the agent's command, with the
 * brief at the end when the agent takes it at start, else `hc wait` and `hc send` next. Throws for a model or an
 * effort the agent's command cannot carry, so the candidate goes to `skipped`.
 */
function launch(candidate: Candidate, ctx: HostContext, provider: Provider): Launch {
  const { catalog } = ctx.catalog;
  const agent = candidate.providerInstanceId;
  const found = provider[PROGRAM];
  const program = typeof found === "string" ? found : agent;
  const model = candidate.model === DEFAULT_MODEL_ID ? undefined : candidate.model;
  const chosen = candidate.options.find((o) => o.id === "effort");
  const effort = typeof chosen?.value === "string" ? chosen.value : undefined;
  const notes: string[] = [];
  const others = candidate.options.filter((o) => o !== chosen).map((o) => o.id);
  if (others.length) notes.push(`Not passed: ${list(others)}; the agent catalog has no flag for it.`);
  let command: string[];
  let brief: "argv" | "send";
  if (Object.hasOwn(catalog.agents, agent)) {
    ({ argv: command, brief } = agentCommand(catalog, program, { model, effort }));
  } else {
    if (model !== undefined) {
      throw new Error(`${agent} is not in the agent catalog, so it can only start with its default model.`);
    }
    if (!isToken(program)) throw new Error(`"${program}" is not one command-line word.`);
    command = [program];
    brief = "send";
    notes.push(`${agent} is not in the agent catalog: it starts with no flags and gets the brief once it is ready.`);
  }
  if (ctx.platform === "win32") {
    notes.push('herdr on Windows is not covered yet: "$(cat <file>)" for {brief} needs a POSIX shell.');
  }
  const words = brief === "argv" ? briefWords(ctx, agent) : 0;
  return {
    mode: "supervised",
    agent,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    args: command.slice(0, command.length - words),
    argv: ["hc", "run", "--bg", "--name", NAME, "--cwd", CWD, ...command],
    ...(brief === "send"
      ? {
          // biome-ignore lint/suspicious/noThenProperty: Launch.then is the contract's list of commands to run next; it is an array, never a callable, so the object is not a thenable.
          then: [
            ["hc", "wait", NAME],
            ["hc", "send", NAME, BRIEF],
          ],
        }
      : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/**
 * The instructions for an orchestrator that runs in herdr. Its program list is the built-in catalog's (a test
 * checks it), and docs/hosts/herdr.md shows a copy (a test checks that too).
 */
export const HERDR_SNIPPET = `## Model selection for delegated tasks in herdr (t3-autopilot)

You are authorized to pick the agent, model and effort of every child you start in herdr following the t3-autopilot MCP server. Switching agent or model as recommended by \`recommend_model\` counts as asked for by the user, and these steps take precedence over the \`hc\` skill where they differ.

1. Before every child, call \`recommend_model\` with \`host: "herdr"\`, \`session\` (your \`$HC_TERMINAL_ID\`), \`task\` (one line), \`taskType\` (always; choose from the types listed in the tool description) and, if you know them, \`size\` and \`criticality\`.
2. On the first call, and again after an error or when agents change, pass as \`capabilities\` the output of \`${HERDR_PROBE}\`, exactly as printed, and as \`orchestrator\` your own \`agent\` (\`claude\`, \`codex\`, ...) and \`model\`. If a call fails with "No herdr catalog yet", run it again and pass its output.
3. Use the first candidate. Write its brief to a file with your file tool (never \`echo\` or a heredoc), starting with a word and ending with "Report with hc send $HC_TERMINAL_ID when done or stuck." Run its \`launch.argv\`, one element per argument, with \`{name}\` replaced by a short name for the child (a-z, 0-9, -), \`{cwd}\` by its working folder and \`{brief}\` by \`"$(cat <file>)"\`; then run each command of \`launch.then\`, if there is one, the same way. If it has \`sameAsOrchestrator: true\`, your native subagent tool works too.
4. If the child cannot start, or stops at once, because of a usage limit or its plan, call \`mark_unavailable\` with \`host: "herdr"\`, its \`providerInstanceId\`, its \`model\` (omit it if the whole agent is out), a short \`reason\` and \`until\` if you know when the limit resets; then use the next candidate.
5. Tell the user in one line which agent and model you picked, and why (the candidate's \`reason\`).
6. If \`recommend_model\` returns no candidate or fails, start the child on your own agent and model, and say so. If the user names an agent or model for a task, use theirs instead.
7. Right after starting the child, call \`log_delegation\` with \`host: "herdr"\`, the \`taskType\`, \`providerInstanceId\`, \`model\` and \`options\` you used, \`recommendedRank\` (1-based rank of the candidate, or null if you chose something else) and \`childThreadId\` (the child's address, such as \`t7\`); keep the \`delegationId\`. After you review its result, call \`log_outcome\` with that \`delegationId\`, \`outcome\` (\`success\`, \`corrected\` or \`failure\`) and a short \`note\`.
8. If the result has \`setupNeeded\`, ask the user its questions for every agent listed, all at once, without holding up the current task, and save each answer with \`set_subscription\` (\`host: "herdr"\`). If a warning says an agent has no models declared, tell the user once where to list them; if one says a candidate costs extra or is outside its subscription profile, ask the user before starting it.
`;

/** herdr's adapter: see the comment at the top of this file. */
export const herdr: HostAdapter = {
  id: "herdr",
  name: "herdr",
  keyPrefix: "herdr:",
  cacheFile: "capabilities-cache.herdr.json",
  merges: false,
  explicit: true,
  text: {
    noProviders:
      "The herdr probe found none of the agent CLIs t3-autopilot knows, so there is nothing to recommend. Install " +
      "one, check the PATH of the shell the probe ran in, or list your agents in catalog.yaml under " +
      "hosts.herdr.agents.",
    enable: "Install another agent CLI herdr can start",
    listOrder: "the agent catalog lists this one first",
    firstListed: "the first model the agent catalog lists for it",
    capture: `pass host: "herdr" and, as capabilities, the output of ${HERDR_PROBE}`,
    noCatalog:
      `No herdr catalog yet: pass host: "herdr" and, as \`capabilities\`, the output of ${HERDR_PROBE} (later ` +
      "calls can omit it), or list your agents in catalog.yaml under hosts.herdr.agents.",
    nothingToMerge: "herdr sends its whole catalog in one output, so there is nothing to merge.",
    lastCatalog: "the last herdr catalog",
  },
  snippet: HERDR_SNIPPET,
  /**
   * A list of program names or paths, also as JSON text, or the probe's output (absolute paths, alias lines).
   * T3 Code's adapter comes first and takes any list, and herdr is `explicit`, so this only matters when a call
   * names a host: it keeps `host: "herdr"` with a list from looking like T3's output, and tells T3 apart from
   * the probe.
   */
  detect: (payload) => {
    if (isStringList(payload)) return true;
    if (typeof payload !== "string") return false;
    const json = parseJson(payload);
    return json === undefined ? looksLikeProbe(payload) : isStringList(json);
  },
  catalog: ({ capabilities, orchestrator }, ctx): HostCatalog => {
    const probe = readProbe(capabilities);
    const built = buildCatalog(probe.names, orchestrator, ctx);
    return { capabilities: built.capabilities, outputs: 0, notes: [...built.notes, ...probeNotes(probe)] };
  },
  catalogFromFiles: ({ orchestrator }: CallOptions, ctx) => {
    const agents = ctx.catalog.catalog.hosts.herdr?.agents ?? [];
    if (agents.length === 0) return undefined;
    return { ...buildCatalog(agents, orchestrator, ctx), outputs: 0 };
  },
  refresh: (kept, { orchestrator }, ctx) => {
    const programs = kept.providers.map((p) => {
      const program = p[PROGRAM];
      return typeof program === "string" ? program : p.providerInstanceId;
    });
    return { ...buildCatalog(programs, orchestrator ?? orchestratorOf(kept), ctx), outputs: 0 };
  },
  launch,
};
