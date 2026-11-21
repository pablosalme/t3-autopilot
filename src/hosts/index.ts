import { join } from "node:path";
import { type LoadedCatalog, loadCatalog } from "../catalog.js";
import { DATA_FILES } from "../paths.js";
import type { CandidateRule, Policy } from "../policy.js";
import { herdr } from "./herdr.js";
import { t3 } from "./t3.js";
import type { HostAdapter, HostContext, HostId } from "./types.js";

/**
 * The hosts this version knows, the default one first: a call that names no
 * host, and that a payload does not tell apart, is for it. A new host is a
 * file in this folder and one line here (see "Adding a host" in
 * CONTRIBUTING.md). Orca's adapter (src/hosts/orca.ts, PR #2 rewritten on
 * this seam) goes after herdr; `snippet --host orca` and `--host all` then
 * pick it up from here.
 */
export const HOSTS: readonly HostAdapter[] = [t3, herdr];

/** What `snippet --host` takes for every host's instructions at once. Never a host id. */
export const ALL_HOSTS = "all";

/** A snippet without its title: what follows its first blank line. */
function snippetBody(snippet: string): string {
  const at = snippet.indexOf("\n\n");
  return at === -1 ? snippet : snippet.slice(at + 2);
}

/**
 * `snippet --host all`: how to tell which host the orchestrator runs in, then each host's instructions under its
 * name, in the registry's order, for one rules file read by agents in several hosts. With one host, its snippet.
 */
export function allHostsSnippet(hosts: readonly HostAdapter[] = HOSTS): string {
  const [only] = hosts;
  if (hosts.length === 1 && only) return only.snippet;
  const which = hosts.map((h) => `- ${h.name}: ${h.recognize}.`).join("\n");
  const sections = hosts.map((h) => `### ${h.name}\n\n${snippetBody(h.snippet)}`).join("\n");
  return (
    "## Model selection for delegated tasks, in every host (t3-autopilot)\n\n" +
    "These instructions cover every host t3-autopilot supports. First find the one you run in, the first of these " +
    `that applies, then follow only its section:\n\n${which}\n\nIf none of them applies, do not call t3-autopilot.` +
    `\n\n${sections}`
  );
}

/** The host of calls that name none: T3 Code, as in every 0.1 version. Its ids are stored with no prefix. */
export const DEFAULT_HOST: HostAdapter = t3;

/** What a call says, or lets the server infer, about its host. */
export interface HostQuery {
  /** The `host` argument. */
  host?: string;
  /** recommend_model's `capabilities`, whose shape may tell the host apart. */
  payload?: unknown;
  /** The host of this process's last recommend_model call: one stdio process serves one agent session. */
  last?: HostAdapter;
}

/**
 * The host a call is for: the one it names, else the one whose shape its
 * payload has, else the host of the last recommend_model call, else the
 * default host. Throws when the named host is unknown, when the payload looks
 * like another host's output, and when it has the shape of an `explicit`
 * host's payload but the call names no host (unless the last call was for it).
 */
export function resolveHost(query: HostQuery, hosts: readonly HostAdapter[] = HOSTS): HostAdapter {
  const { host, payload, last } = query;
  if (host !== undefined) {
    const named = hosts.find((h) => h.id === host);
    if (!named) throw new Error(`Unknown host "${host}". Known hosts: ${hosts.map((h) => h.id).join(", ")}.`);
    if (payload !== undefined && !named.detect(payload)) {
      const like = hosts.find((h) => h !== named && h.detect(payload));
      if (like) {
        throw new Error(
          `host is "${named.id}", but capabilities look like ${like.name} output (host "${like.id}"). ` +
            `Pass the host you run in and the output of that host.`,
        );
      }
    }
    return named;
  }
  const detected = payload === undefined ? undefined : hosts.find((h) => h.detect(payload));
  if (detected?.explicit && detected !== last) {
    throw new Error(
      `capabilities look like ${detected.name} output, but the call names no host: pass host: "${detected.id}".`,
    );
  }
  return detected ?? last ?? hosts[0] ?? DEFAULT_HOST;
}

/** The key a host stores one of its ids under: T3's ids as they are, any other host's with its prefix. */
export function storageKey(host: HostAdapter, id: string): string {
  return `${host.keyPrefix}${id}`;
}

/**
 * Which host a stored key belongs to, and the id in it. A key with `:` is
 * the host's named before it (T3's provider instance ids never have one:
 * `^[a-zA-Z][a-zA-Z0-9_-]*$`); any other key, and one that starts with `t3:`,
 * is T3's, whole, so T3 reads every key as 0.1 did.
 */
export function splitKey(key: string): { host: HostId; id: string } {
  const colon = key.indexOf(":");
  const prefix = key.slice(0, Math.max(colon, 0));
  return prefix && prefix !== DEFAULT_HOST.id
    ? { host: prefix, id: key.slice(colon + 1) }
    : { host: DEFAULT_HOST.id, id: key };
}

/**
 * A stored key as host H sees it: its own ids without a prefix, other hosts'
 * with theirs (T3's as `t3:<id>`). For T3 it is the key itself.
 */
export function viewKey(host: HostAdapter, key: string): string {
  const { host: owner, id } = splitKey(key);
  return owner === host.id ? id : `${owner}:${id}`;
}

/** Whether a stored key is one of a host's ids. */
export function isOwnKey(host: HostAdapter, key: string): boolean {
  return splitKey(key).host === host.id;
}

/** A record keyed by stored keys, keyed as the host sees them (see {@link viewKey}). */
export function viewOf<T>(host: HostAdapter, record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [viewKey(host, key), value]));
}

/** Items with a `providerInstanceId` (marks, log records), as the host sees them. */
export function viewItems<T extends { providerInstanceId: string }>(host: HostAdapter, items: readonly T[]): T[] {
  return items.map((item) => ({ ...item, providerInstanceId: viewKey(host, item.providerInstanceId) }));
}

/**
 * A record keyed by stored keys split for a host's tool results: its own
 * entries without a prefix, and the other hosts' with theirs.
 */
export function splitOwn<T>(
  host: HostAdapter,
  record: Readonly<Record<string, T>>,
): { own: Record<string, T>; others: Record<string, T> } {
  const own: Record<string, T> = {};
  const others: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isOwnKey(host, key)) own[viewKey(host, key)] = value;
    else others[viewKey(host, key)] = value;
  }
  return { own, others };
}

/**
 * The policy as a host sees it: the ids of `excludeProviders` and of the
 * candidates' `instance` are stored keys, so `excludeProviders: [codex]`
 * applies to T3 only and `[orca:codex]` to Orca only.
 */
export function viewPolicy(host: HostAdapter, policy: Policy): Policy {
  const rules = (list: CandidateRule[]) =>
    list.map((rule) => (rule.instance === undefined ? rule : { ...rule, instance: viewKey(host, rule.instance) }));
  return {
    ...policy,
    excludeProviders: policy.excludeProviders.map((key) => viewKey(host, key)),
    taskTypes: Object.fromEntries(
      Object.entries(policy.taskTypes).map(([name, type]) => [name, { ...type, candidates: rules(type.candidates) }]),
    ),
    fallback: rules(policy.fallback),
  };
}

/**
 * The context of one call, for its host's adapter. The agent catalog is read from the data directory the first
 * time the adapter reads `catalog`, and kept for the rest of the call.
 */
export function hostContext(dataDir: string, now: Date, policy: Policy, platform = process.platform): HostContext {
  let catalog: LoadedCatalog | undefined;
  return {
    dataDir,
    now,
    policy,
    platform,
    get catalog() {
      catalog ??= loadCatalog({ userPath: join(dataDir, DATA_FILES.catalog), families: Object.keys(policy.families) });
      return catalog;
    },
  };
}
