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

/** Whether `value` is one safe command-line word for a model id, effort, alias or executable. */
export function isToken(value: string): boolean {
  return value.length <= MAX_TOKEN_LENGTH && TOKEN.test(value);
}

const Token = z
  .string()
  .max(MAX_TOKEN_LENGTH)
  .regex(TOKEN, "must be one word of letters, digits and . _ : / @ + = , [ ] -, not starting with -");

const AgentId = z.string().max(64).regex(AGENT_ID, "must start with a letter and have only letters, digits, - and _");

const Efforts = z.array(Token);

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
 * for it (Orca's `opencode2` is `opencode`). Undefined for an agent the
 * catalog does not know.
 */
export function resolveAgent(catalog: AgentCatalog, host: CatalogHost, id: string): string | undefined {
  if (Object.hasOwn(catalog.agents, id)) return id;
  const aliases = catalog.hosts[host]?.aliases ?? {};
  return Object.hasOwn(aliases, id) ? aliases[id] : undefined;
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
