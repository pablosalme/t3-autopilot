import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Model, Provider } from "./capabilities.js";
import { autopilotHome } from "./paths.js";

/**
 * The agent catalog: the agent CLIs that hosts without a model list (Orca,
 * herdr) start, and the models and efforts each takes. The package ships
 * catalog/agents.yaml; the user extends it in <data dir>/catalog.yaml. T3 Code
 * lists its own models and never reads it. Pure functions plus a loader: no
 * tool output uses the catalog yet.
 */

/** Hosts that read the catalog. T3 Code is not one of them. */
export const CATALOG_HOSTS = ["orca", "herdr"] as const;
export type CatalogHost = (typeof CATALOG_HOSTS)[number];

/** Model id that means "start the CLI without a model": the one set in its own config. */
export const DEFAULT_MODEL_ID = "default";

/** The longest token the catalog accepts. */
export const MAX_TOKEN_LENGTH = 200;

/**
 * One command-line word: no spaces, no shell characters (`; | & $ \` ' " < > ( ) { } * ? ~ ! #`) and no
 * leading dash, so a model id such as `--dangerously-skip-permissions` cannot pass as an option.
 * Brackets are allowed for aliases such as `opus[1m]`.
 */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+=,[\]-]*$/;

/** An agent id is also the provider instance id the engine sees: a T3-style slug, never with `:`. */
const AGENT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A command-line word that may also be an option (`-m`, `--no-daemon`, `--effort=high`) or the end of options (`--`). */
const ARG = /^(?:--?)?[A-Za-z0-9][A-Za-z0-9._:/@+=,[\]-]*$|^--$/;

/** Whether `value` is one safe command-line word for a model id, effort, alias or executable. */
export function isToken(value: string): boolean {
  return value.length <= MAX_TOKEN_LENGTH && TOKEN.test(value);
}

function isArg(value: string): boolean {
  return value.length <= MAX_TOKEN_LENGTH && ARG.test(value);
}

/** Where the brief goes in an agent's command: a whole argument, filled in by the host (herdr). */
export const BRIEF = "{brief}";

const Token = z
  .string()
  .max(MAX_TOKEN_LENGTH)
  .regex(TOKEN, "must be one word of letters, digits and . _ : / @ + = , [ ] -, not starting with -");

const AgentId = z.string().max(64).regex(AGENT_ID, "must start with a letter and have only letters, digits, - and _");

const Efforts = z.array(Token);

const Arg = z
  .string()
  .max(MAX_TOKEN_LENGTH)
  .regex(ARG, "must be one word of letters, digits and . _ : / @ + = , [ ] -, an option such as --model, or --");

/**
 * Command-line words around one placeholder, such as `[--model, "{model}"]`. The placeholder appears once, as a
 * whole word or, when `inside` allows it, within one (`model_reasoning_effort={effort}`); the other words are
 * {@link Arg}s.
 */
function template(placeholder: string, inside: boolean) {
  return z
    .array(z.string())
    .min(1)
    .superRefine((words, ctx) => {
      let uses = 0;
      words.forEach((word, i) => {
        const count = word.split(placeholder).length - 1;
        uses += count;
        const ok =
          word === placeholder ||
          (count === 0 ? isArg(word) : inside && count === 1 && isArg(word.replace(placeholder, "x")));
        if (!ok) {
          ctx.addIssue({
            code: "custom",
            path: [i],
            message: inside
              ? `must be one command-line word, ${placeholder}, or one word with ${placeholder} in it`
              : `must be one command-line word or ${placeholder}`,
          });
        }
      });
      if (uses !== 1) ctx.addIssue({ code: "custom", message: `must have ${placeholder} exactly once` });
    });
}

/** A model: `{ id, family?, efforts? }`, or its id alone. */
export const CatalogModelSchema = z.preprocess(
  (value) => (typeof value === "string" ? { id: value } : value),
  z.strictObject({
    /** What the CLI takes as a model; `default` means none. */
    id: Token,
    /** Policy family of an id no family regex recognizes (`opus`, Codex's `default`). */
    family: z.string().min(1).optional(),
    /** Efforts of this model; replaces the agent's. `[]`: no effort. */
    efforts: Efforts.optional(),
  }),
);

/** What changes for an agent in one host. */
export const HostOverrideSchema = z.strictObject({
  /** false: the host rejects a model at launch, so only `default` is offered. */
  model: z.literal(false).optional(),
  models: z.array(CatalogModelSchema).optional(),
  efforts: Efforts.optional(),
  note: z.string().optional(),
});

const HostOverridesSchema = z.strictObject({
  orca: HostOverrideSchema.optional(),
  herdr: HostOverrideSchema.optional(),
});

export const CatalogAgentSchema = z.strictObject({
  /** Driver kind for policy families and `provider:` rules (`claudeAgent`, `codex`); the agent id when absent. */
  driver: Token.optional(),
  name: z.string().optional(),
  models: z.array(CatalogModelSchema).optional(),
  /** Efforts the agent takes, for models that do not list their own. */
  efforts: Efforts.optional(),
  hosts: HostOverridesSchema.optional(),
  // How herdr runs the agent: herdr starts a program with arguments and knows nothing about models.
  /** Program to run; the agent id when absent. */
  exe: Token.optional(),
  /** Other executable names of the same agent, to recognize it on PATH (`opencode2`). */
  aliases: z.array(Token).optional(),
  /** Words always passed after the program (`--no-daemon` for Codex). */
  args: z.array(Arg).optional(),
  /** How the CLI takes a model and an effort. No `model` (or `effort`): the CLI takes none at start. */
  flags: z
    .strictObject({ model: template("{model}", false).optional(), effort: template("{effort}", true).optional() })
    .optional(),
  /**
   * How the agent takes the brief: `positional` (the last argument), `send` (start it, wait until it is
   * ready, then send the brief), or the words that carry it (`[--prompt, "{brief}"]`). Default: `send`.
   */
  prompt: z.union([z.enum(["positional", "send"]), template(BRIEF, false)]).optional(),
  /** The CLI version whose `--help` these fields were checked against (informative). */
  checked: z.string().optional(),
});

const HostSectionSchema = z.strictObject({
  /** Ids this host uses for an agent of the catalog. */
  aliases: z.record(Token, AgentId).default({}),
});

export const AgentCatalogSchema = z.strictObject({
  version: z.literal(1),
  /** When the catalog was last reviewed (informative). */
  updated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-11-21")
    .optional(),
  agents: z.record(AgentId, CatalogAgentSchema).default({}),
  hosts: z.strictObject({ orca: HostSectionSchema.optional(), herdr: HostSectionSchema.optional() }).default({}),
});

export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type HostOverride = z.infer<typeof HostOverrideSchema>;
export type CatalogAgent = z.infer<typeof CatalogAgentSchema>;
export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `base` with each key of `override` set, or removed when null. */
function mergeKeys(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__") continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Merge a user catalog onto the built-in one.
 * - `agents`: by id. An agent in both is merged one level deep: each key the
 *   user sets (`models`, `efforts`, `hosts`...) replaces the built-in value.
 *   null removes an agent, or a key of one.
 * - `hosts`: by host; `aliases` merged by alias, null removing one.
 * - Everything else (`version`, `updated`): replaced.
 */
export function mergeCatalog(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__") continue;
    if (key === "agents" && isPlain(value)) {
      const agents: Plain = { ...(isPlain(base.agents) ? base.agents : {}) };
      for (const [id, entry] of Object.entries(value)) {
        if (id === "__proto__") continue;
        const was = agents[id];
        if (entry === null) delete agents[id];
        else agents[id] = isPlain(entry) && isPlain(was) ? mergeKeys(was, entry) : entry;
      }
      out.agents = agents;
    } else if (key === "hosts" && isPlain(value)) {
      const hosts: Plain = { ...(isPlain(base.hosts) ? base.hosts : {}) };
      for (const [host, section] of Object.entries(value)) {
        if (host === "__proto__") continue;
        const was = hosts[host];
        if (section === null) delete hosts[host];
        else if (isPlain(section) && isPlain(was)) {
          const { aliases, ...rest } = section;
          const merged = mergeKeys(was, rest);
          if (isPlain(aliases)) merged.aliases = mergeKeys(isPlain(was.aliases) ? was.aliases : {}, aliases);
          else if (aliases !== undefined) merged.aliases = aliases;
          hosts[host] = merged;
        } else hosts[host] = section;
      }
      out.hosts = hosts;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** "agents.claude.models[0]" for ["agents", "claude", "models", 0]. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i ? "." : ""}${String(p)}`)).join("");
}

export interface CheckedCatalog {
  catalog: AgentCatalog;
  /** Unknown keys, unknown families and aliases that were ignored, one message each. */
  warnings: string[];
}

/**
 * Validate a raw catalog. Like the policy, a key the schema does not know is
 * ignored and reported in `warnings`; anything else that is wrong (a token with
 * a space or a shell character, a model id starting with `-`) throws. Given the
 * policy's family names, a `family` that is not one of them is dropped with a
 * warning, so the model is matched by its id alone.
 */
export function checkCatalog(raw: unknown, source: string, families?: Iterable<string>): CheckedCatalog {
  const warnings: string[] = [];
  const say = (message: string) => warnings.push(`Agent catalog (${source}): ${message}`);
  let parsed = AgentCatalogSchema.safeParse(raw);
  if (!parsed.success && parsed.error.issues.every((issue) => issue.code === "unrecognized_keys")) {
    // Only unknown keys are wrong: drop them from a copy and validate what is left.
    const pruned: unknown = structuredClone(raw);
    for (const issue of parsed.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      let holder: unknown = pruned;
      for (const step of issue.path) holder = (holder as Record<PropertyKey, unknown>)[step];
      const where = issue.path.length ? `under ${formatPath(issue.path)}` : "at the top level";
      for (const key of issue.keys) {
        delete (holder as Plain)[key];
        say(
          `unknown key "${key}" ${where} is ignored. Check its spelling against "Agent catalog" in docs/reference.md.`,
        );
      }
    }
    parsed = AgentCatalogSchema.safeParse(pruned);
  }
  if (!parsed.success) throw new Error(`Invalid agent catalog (${source}): ${z.prettifyError(parsed.error)}`);
  const catalog = parsed.data;

  // Cross-checks the schema cannot express: they drop the entry and warn, so one slip does not stop the rest.
  const known = families === undefined ? undefined : new Set(families);
  const checkModels = (models: CatalogModel[] | undefined, where: string): CatalogModel[] | undefined => {
    if (models === undefined) return undefined;
    const seen = new Set<string>();
    return models.flatMap((model, i) => {
      if (seen.has(model.id)) {
        say(`${where}[${i}]: model "${model.id}" is listed twice; the first one is used.`);
        return [];
      }
      seen.add(model.id);
      if (known && model.family !== undefined && !known.has(model.family)) {
        say(`${where}[${i}]: "${model.family}" is not a policy family, so "${model.id}" is matched by its id alone.`);
        const { family: _, ...rest } = model;
        return [rest];
      }
      return [model];
    });
  };
  for (const [id, agent] of Object.entries(catalog.agents)) {
    agent.models = checkModels(agent.models, `agents.${id}.models`);
    for (const host of CATALOG_HOSTS) {
      const override = agent.hosts?.[host];
      if (override) override.models = checkModels(override.models, `agents.${id}.hosts.${host}.models`);
    }
  }
  // Executable names (herdr): one agent each. The first agent that claims a name keeps it.
  const programs = new Map<string, string>();
  for (const [id, agent] of Object.entries(catalog.agents)) {
    const exe = agent.exe ?? id;
    const owner = programs.get(exe);
    if (owner !== undefined) say(`agents.${id}.exe: "${exe}" is ${owner}'s program too; herdr finds ${owner}.`);
    else programs.set(exe, id);
  }
  for (const [id, agent] of Object.entries(catalog.agents)) {
    agent.aliases = agent.aliases?.filter((alias) => {
      const owner = Object.hasOwn(catalog.agents, alias) ? alias : programs.get(alias);
      if (owner !== undefined && owner !== id) {
        say(`agents.${id}.aliases: "${alias}" is already ${owner}'s, so it is ignored.`);
        return false;
      }
      programs.set(alias, id);
      return true;
    });
    if (agent.aliases === undefined) delete agent.aliases;
  }
  for (const host of CATALOG_HOSTS) {
    const aliases = catalog.hosts[host]?.aliases ?? {};
    for (const [alias, target] of Object.entries(aliases)) {
      if (Object.hasOwn(catalog.agents, alias)) {
        say(`hosts.${host}.aliases.${alias}: "${alias}" is an agent of the catalog, so the alias is ignored.`);
        delete aliases[alias];
      } else if (!Object.hasOwn(catalog.agents, target)) {
        say(`hosts.${host}.aliases.${alias}: "${target}" is not an agent of the catalog, so the alias is ignored.`);
        delete aliases[alias];
      }
    }
  }
  return { catalog, warnings };
}

/** The catalog shipped with the package (works from src/ and dist/). */
export function builtinCatalogPath(): string {
  return fileURLToPath(new URL("../catalog/agents.yaml", import.meta.url));
}

/** The user's additions: catalog.yaml in the data directory ($T3_AUTOPILOT_HOME or ~/.t3-autopilot). */
export function userCatalogPath(): string {
  return join(autopilotHome(), "catalog.yaml");
}

function readYaml(path: string): Plain {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new Error(`${path}: cannot read agent catalog YAML: ${(e as Error).message}`);
  }
  if (raw === null || raw === undefined) return {};
  if (!isPlain(raw)) throw new Error(`${path}: expected a YAML mapping at the top level`);
  return raw;
}

export interface LoadedCatalog extends CheckedCatalog {
  /** Files the catalog was built from, in merge order. */
  sources: string[];
}

/**
 * Load the built-in catalog and merge the user's catalog.yaml onto it when it
 * exists. `families` (the policy's family names) turns on the family check.
 */
export function loadCatalog(
  opts: { builtinPath?: string; userPath?: string; families?: Iterable<string> } = {},
): LoadedCatalog {
  const builtinPath = opts.builtinPath ?? builtinCatalogPath();
  const userPath = opts.userPath ?? userCatalogPath();
  let raw = readYaml(builtinPath);
  const sources = [builtinPath];
  if (existsSync(userPath)) {
    raw = mergeCatalog(raw, readYaml(userPath));
    sources.push(userPath);
  }
  // The built-in catalog is valid on its own (tested), so errors after a merge come from the user's file.
  const label = sources.length > 1 ? `${userPath}, on top of the built-in catalog` : builtinPath;
  return { ...checkCatalog(raw, label, opts.families), sources };
}

/**
 * The catalog id of an agent a host names: the id itself, or the host's alias
 * for it (Orca's `opencode2` is `opencode`); in herdr, which names programs,
 * also an agent's `exe` or one of its `aliases` (`cursor-agent` is `cursor`).
 * Undefined for an agent the catalog does not know.
 */
export function resolveAgent(catalog: AgentCatalog, host: CatalogHost, id: string): string | undefined {
  if (Object.hasOwn(catalog.agents, id)) return id;
  const aliases = catalog.hosts[host]?.aliases ?? {};
  if (Object.hasOwn(aliases, id)) return aliases[id];
  if (host !== "herdr") return undefined;
  const agents = Object.entries(catalog.agents);
  return (agents.find(([, a]) => a.exe === id) ?? agents.find(([, a]) => a.aliases?.includes(id)))?.[0];
}

/** An agent as one host sees it, with its `hosts.<host>` override applied. */
export interface AgentView {
  /** Catalog id, or the id the host gave for an agent the catalog does not know. */
  id: string;
  /** Whether the catalog has an entry for it. */
  known: boolean;
  driver: string;
  name: string;
  /** Models to offer; `[default]` when none are declared or the host rejects a model at launch. */
  models: CatalogModel[];
  /** The agent's efforts in this host, for models without their own. */
  efforts: string[];
  /** false: the host rejects a model at launch (`hosts.<host>.model: false`). */
  selectsModel: boolean;
  note?: string;
}

/** {@link AgentView} of an agent a host names (an alias resolves to its agent). */
export function agentView(catalog: AgentCatalog, host: CatalogHost, id: string): AgentView {
  const canonical = resolveAgent(catalog, host, id);
  const agent = canonical === undefined ? undefined : catalog.agents[canonical];
  if (canonical === undefined || agent === undefined) {
    return {
      id,
      known: false,
      driver: id,
      name: id,
      models: [{ id: DEFAULT_MODEL_ID }],
      efforts: [],
      selectsModel: true,
    };
  }
  const override = agent.hosts?.[host];
  const selectsModel = override?.model !== false;
  const declared = override?.models ?? agent.models ?? [];
  const fallback = declared.find((m) => m.id === DEFAULT_MODEL_ID) ?? { id: DEFAULT_MODEL_ID };
  const models = selectsModel && declared.length > 0 ? declared : [fallback];
  const view: AgentView = {
    id: canonical,
    known: true,
    driver: agent.driver ?? canonical,
    name: agent.name ?? canonical,
    models,
    efforts: override?.efforts ?? agent.efforts ?? [],
    selectsModel,
  };
  if (override?.note !== undefined) view.note = override.note;
  return view;
}

/**
 * The agent as a provider of the engine's catalog (the shape
 * orchestrator_capabilities gives in T3): one provider per agent, whose
 * instance id is the agent id. Each model declares its policy family
 * (`policyFamily`) when the catalog gives one, and its efforts as an `effort`
 * option, the first id of the policy's `effortOptionIds`. Installed is not
 * signed in, but marks catch that, so the provider can always run a child.
 * Host rules beyond the catalog (Orca takes an effort only with a model) are
 * the host adapter's.
 */
export function agentProvider(catalog: AgentCatalog, host: CatalogHost, id: string): Provider {
  const view = agentView(catalog, host, id);
  const models = view.models.map((m): Model => {
    const model: Model = { id: m.id };
    if (m.family !== undefined) model.policyFamily = m.family;
    const efforts = m.efforts ?? view.efforts;
    if (efforts.length > 0) model.options = [{ id: "effort", values: [...efforts] }];
    return model;
  });
  return {
    providerInstanceId: view.id,
    driverKind: view.driver,
    displayName: view.name,
    models,
    omittedModels: 0,
    canRunChildTask: true,
    constraints: [],
  };
}

/** A model and an effort to start an agent with; `default` or absent: none. */
export interface AgentSelection {
  model?: string;
  effort?: string;
}

/** How to start an agent (herdr). */
export interface AgentCommand {
  /** Catalog id of the agent. */
  agent: string;
  /** The command, one element per argument; {@link BRIEF} stands for the brief when the agent takes it at start. */
  argv: string[];
  /** `argv`: the brief is in `argv`. `send`: start the agent, wait until it is ready, then send the brief. */
  brief: "argv" | "send";
}

/** The words of a flag template with its placeholder replaced by `value`, checked again as words. */
function fill(words: readonly string[], placeholder: string, value: string, what: string, agent: string): string[] {
  if (!isToken(value)) {
    throw new Error(
      `${agent}: ${what} "${value}" is not one command-line word (letters, digits, . _ : / @ + = , [ ] -).`,
    );
  }
  return words.map((word) => {
    const out = word.split(placeholder).join(value);
    if (!isArg(out))
      throw new Error(`${agent}: ${what} "${value}" makes "${out}", which is not one command-line word.`);
    return out;
  });
}

/**
 * The command that starts an agent of the catalog with a model and an
 * effort, as a list of arguments (never a shell string). `id` is what herdr
 * found: an agent id, an alias, or one of the agent's executable names, which
 * is then the program run (`opencode2`). Throws for an agent the catalog does
 * not have, a model or an effort the CLI takes no flag for, and a value that is
 * not one safe command-line word.
 */
export function agentCommand(catalog: AgentCatalog, id: string, selection: AgentSelection = {}): AgentCommand {
  const canonical = resolveAgent(catalog, "herdr", id);
  const agent = canonical === undefined ? undefined : catalog.agents[canonical];
  if (canonical === undefined || agent === undefined) {
    throw new Error(`"${id}" is not an agent of the catalog. Add it to catalog.yaml with its exe and flags.`);
  }
  const exe = agent.exe ?? canonical;
  const program = id === exe || agent.aliases?.includes(id) ? id : exe;
  const argv = [program, ...(agent.args ?? [])];
  const { model, effort } = selection;
  if (model !== undefined && model !== DEFAULT_MODEL_ID) {
    if (!agent.flags?.model) {
      throw new Error(`${canonical} takes no model at start. Set agents.${canonical}.flags.model in catalog.yaml.`);
    }
    argv.push(...fill(agent.flags.model, "{model}", model, "model", canonical));
  }
  if (effort !== undefined) {
    if (!agent.flags?.effort) {
      throw new Error(`${canonical} takes no effort at start. Set agents.${canonical}.flags.effort in catalog.yaml.`);
    }
    argv.push(...fill(agent.flags.effort, "{effort}", effort, "effort", canonical));
  }
  const prompt = agent.prompt ?? "send";
  if (prompt === "send") return { agent: canonical, argv, brief: "send" };
  argv.push(...(prompt === "positional" ? [BRIEF] : prompt));
  return { agent: canonical, argv, brief: "argv" };
}
