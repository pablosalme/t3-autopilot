import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cliMain.js";
import { VERSION } from "../src/server.js";
import { connectServer, defaultPolicy, driverFixtureRaw, tempDir } from "./helpers.js";

/*
 * Golden snapshots: what a T3 Code orchestrator gets from t3-autopilot 0.1.3, frozen before the
 * multi-host work so that it cannot change by accident. Each file in test/golden/ holds the exact
 * results of a series of tool calls (the JSON the server returns, or the error text), the files the
 * server wrote, or the CLI's output. The server's clock is fixed; paths, delegation ids, log
 * timestamps and the version are replaced by placeholders.
 *
 * They change only in a pull request that says what changes for T3 and why. To regenerate them:
 *   npx vitest run test/golden.test.ts -u
 */

const T0 = Date.parse("2026-11-21T09:00:00.000Z");
const HOUR = 3_600_000;

/** Files the server writes in its data directory; their paths are shown as `<home>/<name>`. */
const DATA_FILES = ["policy.yaml", "log.jsonl", "unavailable.json", "capabilities-cache.json", "subscriptions.yaml"];

/**
 * Each tool's parameters in 0.1.3, in order. The snapshot keeps the schema of these and the `required`
 * list: a parameter added later is additive (it is not required, or `required` would change), so what a
 * 0.1.x snippet sends still means the same.
 */
const PARAMETERS_0_1_3: Readonly<Record<string, readonly string[]>> = {
  recommend_model: ["task", "taskType", "size", "criticality", "capabilities", "mergeCapabilities", "usage"],
  log_delegation: ["taskType", "providerInstanceId", "model", "options", "recommendedRank", "childThreadId", "summary"],
  log_outcome: ["delegationId", "taskType", "providerInstanceId", "model", "outcome", "note"],
  mark_unavailable: ["providerInstanceId", "model", "reason", "until", "clear"],
  set_subscription: [
    "providerInstanceId",
    "plan",
    "quota",
    "purpose",
    "role",
    "quotaPool",
    "quotaWindow",
    "includedFamilies",
    "paidFamilies",
    "onlyFamilies",
    "avoidFamilies",
    "onlyTaskTypes",
    "remove",
  ],
  get_subscriptions: [],
  get_stats: ["since", "taskType"],
};

const TASK_TYPES = Object.keys(defaultPolicy().taskTypes);

const raw = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

/** The text of a snapshot file: JSON with two spaces and a final newline. */
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Replaces what changes from run to run, in every string of `value` (and `ts`, the log's clock). */
function normalizer(home: string): (value: unknown) => unknown {
  const text = (s: string) => {
    let out = s;
    for (const file of DATA_FILES) out = out.split(join(home, file)).join(`<home>/${file}`);
    return out
      .split(home)
      .join("<home>")
      .replace(/\bd_[0-9a-f]{12}\b/g, "d_<id>");
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return key === "ts" ? "<ts>" : text(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return (value) => walk(value);
}

interface Session {
  client: Client;
  home: string;
  /** A tool call's result, normalized: the JSON the server returned, or `{ error }` with the message. */
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** A data file, normalized: parsed JSON, the JSONL lines parsed, or the text. */
  file: (name: string) => unknown;
}

/** A server on `home` (a new temporary directory by default) whose clock reads `at`. */
async function open(home = tempDir(), at = T0): Promise<Session> {
  const { client } = await connectServer(home, { now: () => new Date(at) });
  const normalize = normalizer(home);
  return {
    client,
    home,
    call: async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = ((res.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      return normalize(res.isError ? { error: text } : JSON.parse(text));
    },
    file: (name) => {
      const content = readFileSync(join(home, name), "utf8");
      if (name.endsWith(".json")) return normalize(JSON.parse(content));
      if (name.endsWith(".jsonl")) {
        return normalize(
          content
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      }
      return normalize(content);
    },
  };
}

const recommend = (s: Session, args: Record<string, unknown>) => s.call("recommend_model", { task: "x", ...args });

/** The profiles of the user's real case, on the invented setup of subscriptions-setup.json. */
const PROFILES: Record<string, Record<string, unknown>> = {
  claudeAgent: { plan: "Claude Max", quota: "generous", role: "primary" },
  grok: {
    plan: "X Subscription Premium ($30)",
    quota: "standard",
    quotaPool: "x-premium",
    quotaWindow: "weekly",
    role: "primary",
  },
  cursor: {
    plan: "X Subscription Premium ($30), includes Cursor Pro",
    quota: "standard",
    quotaPool: "x-premium",
    quotaWindow: "weekly",
    includedFamilies: ["composer", "grok", "grok-build", "grok-fast"],
    paidFamilies: ["claude-opus", "claude-sonnet", "gpt", "gpt-mini", "gemini", "gemini-flash", "gemini-flash-lite"],
  },
  opencode: { plan: "OpenCode Go", quota: "tight", quotaWindow: "5h", role: "experimental", purpose: "try models" },
};

describe("golden: what a T3 Code orchestrator gets", () => {
  it("the server's name and the seven tools, with their 0.1.3 parameters", async () => {
    const s = await open();
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(PARAMETERS_0_1_3));
    const frozen = tools.map((t) => {
      const keep = PARAMETERS_0_1_3[t.name] ?? [];
      const inputSchema = Object.fromEntries(
        Object.entries(t.inputSchema).map(([key, value]) => [
          key,
          key === "properties"
            ? Object.fromEntries(Object.entries(value as object).filter(([name]) => keep.includes(name)))
            : value,
        ]),
      );
      return { name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema };
    });
    const server = s.client.getServerVersion();
    await expect(
      json({
        server: { name: server?.name, version: server?.version === VERSION ? "<version>" : server?.version },
        tools: frozen,
      }),
    ).toMatchFileSnapshot("./golden/tools.json");
  });

  it("recommend_model on capabilities.json: every task type, size, criticality, aliases, the classifier and usage", async () => {
    const s = await open();
    const capabilities = raw("capabilities.json");
    const out: Record<string, unknown> = {};
    for (const taskType of TASK_TYPES) out[taskType] = await recommend(s, { taskType, capabilities });
    out["review, large and highly critical"] = await recommend(s, {
      taskType: "review",
      size: "large",
      criticality: "high",
      capabilities,
    });
    out["code, small and low criticality"] = await recommend(s, {
      taskType: "code",
      size: "small",
      criticality: "low",
      capabilities,
    });
    out["alias implementation"] = await recommend(s, { taskType: "implementation", capabilities });
    out["alias Code Review"] = await recommend(s, { taskType: "Code Review", capabilities });
    out["classifier: keywords"] = await recommend(s, {
      task: "Fix the flaky upload test that fails on CI",
      capabilities,
    });
    out["classifier: no keyword"] = await recommend(s, { task: "Do the thing", capabilities });
    out["usage: weekly 88% on claudeAgent"] = await recommend(s, {
      taskType: "code",
      capabilities,
      usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 88 }] }],
    });
    out["usage: session exhausted on claudeAgent, in two entries"] = await recommend(s, {
      taskType: "review",
      capabilities,
      usage: [
        {
          providerInstanceId: "claudeAgent",
          windows: [{ kind: "session", usedPercent: 100, resetsAt: "2026-11-21T12:00:00Z" }],
        },
        { providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 20 }] },
        { providerInstanceId: "codex", windows: [{ kind: "daily", usedPercent: 120 }] },
      ],
    });
    await expect(json(out)).toMatchFileSnapshot("./golden/recommend-capabilities.json");
  });

  it("recommend_model on the real output of 2026-11-20: every task type", async () => {
    const s = await open();
    const capabilities = raw("capabilities-2026-11-20.json");
    const out: Record<string, unknown> = {};
    for (const taskType of TASK_TYPES) out[taskType] = await recommend(s, { taskType, capabilities });
    out["review, large and highly critical"] = await recommend(s, {
      taskType: "review",
      size: "large",
      criticality: "high",
      capabilities,
    });
    await expect(json(out)).toMatchFileSnapshot("./golden/recommend-real-2026-11-20.json");
  });

  it("recommend_model on every driver fixture", async () => {
    const s = await open();
    const names = readdirSync(new URL("./fixtures/drivers/", import.meta.url))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const capabilities = driverFixtureRaw(name);
      out[`${name}: code`] = await recommend(s, { taskType: "code", capabilities });
      out[`${name}: review`] = await recommend(s, { taskType: "review", capabilities });
      out[`${name}: quick`] = await recommend(s, { taskType: "quick", capabilities });
    }
    await expect(json(out)).toMatchFileSnapshot("./golden/recommend-drivers.json");
  });

  it("subscription profiles: setupNeeded, set_subscription, get_subscriptions, marks and shared quotas", async () => {
    const s = await open();
    const capabilities = raw("subscriptions-setup.json");
    const out: Record<string, unknown> = {};
    out["set_subscription before any capabilities"] = await s.call("set_subscription", {
      providerInstanceId: "claudeAgent",
      ...PROFILES.claudeAgent,
    });
    out["remove before any capabilities"] = await s.call("set_subscription", {
      providerInstanceId: "claudeAgent",
      remove: true,
    });
    out["review without profiles"] = await recommend(s, { taskType: "review", capabilities });
    for (const [providerInstanceId, profile] of Object.entries(PROFILES)) {
      out[`set_subscription ${providerInstanceId}`] = await s.call("set_subscription", {
        providerInstanceId,
        ...profile,
      });
    }
    out["set_subscription for an id not in the capabilities, with a pool of its own"] = await s.call(
      "set_subscription",
      { providerInstanceId: "codex-old", plan: "ChatGPT Plus", quota: "standard", quotaPool: "solo" },
    );
    out["remove it"] = await s.call("set_subscription", { providerInstanceId: "codex-old", remove: true });
    out["remove one that does not exist"] = await s.call("set_subscription", {
      providerInstanceId: "nobody",
      remove: true,
    });
    out.get_subscriptions = await s.call("get_subscriptions");
    for (const taskType of TASK_TYPES) out[`${taskType} with profiles`] = await recommend(s, { taskType });
    out["code, large and highly critical, with profiles"] = await recommend(s, {
      taskType: "code",
      size: "large",
      criticality: "high",
    });
    out["mark grok (quotaWindow from its profile)"] = await s.call("mark_unavailable", {
      providerInstanceId: "grok",
      reason: "weekly limit reached",
    });
    out["review with grok marked"] = await recommend(s, { taskType: "review" });
    out["mark opencode (quotaWindow 5h from its profile)"] = await s.call("mark_unavailable", {
      providerInstanceId: "opencode",
      reason: "out of credits",
    });
    out["code with grok and opencode marked: cursor shares grok's pool"] = await recommend(s, { taskType: "code" });
    out["mark claudeAgent until a date"] = await s.call("mark_unavailable", {
      providerInstanceId: "claudeAgent",
      reason: "session limit",
      until: "2026-11-21T14:00:00Z",
    });
    out["code with every included provider marked"] = await recommend(s, { taskType: "code" });
    out["review with every included provider marked"] = await recommend(s, { taskType: "review" });
    out["clear opencode"] = await s.call("mark_unavailable", { providerInstanceId: "opencode", clear: true });
    out["mark the OpenCode Go models (quotaWindow 5h)"] = await s.call("mark_unavailable", {
      providerInstanceId: "opencode",
      model: "opencode-go/*",
      reason: "5-hour limit reached",
    });
    out["quick with the Go models marked"] = await recommend(s, { taskType: "quick" });
    out["mark a provider with no profile (default 24 h)"] = await s.call("mark_unavailable", {
      providerInstanceId: "codex",
      model: "gpt-6.2-codex",
      reason: "not included in your plan",
    });
    out["clear one model"] = await s.call("mark_unavailable", {
      providerInstanceId: "codex",
      model: "gpt-6.2-codex",
      clear: true,
    });
    out["clear grok"] = await s.call("mark_unavailable", { providerInstanceId: "grok", clear: true });
    out["review after clearing grok"] = await recommend(s, { taskType: "review" });
    out["subscriptions.yaml"] = s.file("subscriptions.yaml");
    out["unavailable.json"] = s.file("unavailable.json");
    out["capabilities-cache.json"] = s.file("capabilities-cache.json");

    // A profile written by hand that names a family the policy does not have.
    const byHand = await open();
    writeFileSync(
      join(byHand.home, "subscriptions.yaml"),
      "version: 1\nsubscriptions:\n  cursor:\n    plan: Cursor Pro\n    quota: standard\n    onlyFamilies: [gemmini]\n    onlyTaskTypes: [reviews]\n",
    );
    out["a profile with unknown names"] = await recommend(byHand, { taskType: "review", capabilities });
    // An invalid file: ignored by recommend_model, never overwritten.
    const invalid = await open();
    writeFileSync(join(invalid.home, "subscriptions.yaml"), "version: 2\nsubscriptions: {}\n");
    out["an invalid file: recommend_model"] = await recommend(invalid, { taskType: "review", capabilities });
    out["an invalid file: set_subscription"] = await invalid.call("set_subscription", {
      providerInstanceId: "cursor",
      plan: "Cursor Pro",
      quota: "standard",
    });
    out["an invalid file: get_subscriptions"] = await invalid.call("get_subscriptions");
    await expect(json(out)).toMatchFileSnapshot("./golden/subscriptions.json");
  });

  it("capabilities kept between calls: cache, merges, the disk cache after a restart, expiry", async () => {
    const out: Record<string, unknown> = {};
    const home = tempDir();
    const s = await open(home);
    const mixed = driverFixtureRaw("mixed");
    const search = driverFixtureRaw("search-mixed-cursor-opus");
    out["first call without capabilities"] = await recommend(s, { taskType: "code" });
    out["with capabilities"] = await recommend(s, { taskType: "code", capabilities: mixed });
    out["from the cache"] = await recommend(s, { taskType: "review" });
    out["merge a search"] = await recommend(s, { taskType: "code", capabilities: search, mergeCapabilities: true });
    out["the merge is kept"] = await recommend(s, { taskType: "code" });
    out["capabilities-cache.json after the merge"] = s.file("capabilities-cache.json");

    const restarted = await open(home, T0 + 3.1 * HOUR);
    out["after a restart, 3.1 h later"] = await recommend(restarted, { taskType: "code" });
    out["the same server again"] = await recommend(restarted, { taskType: "quick" });
    out["fresh capabilities"] = await recommend(restarted, { taskType: "code", capabilities: mixed });
    out["cache again"] = await recommend(restarted, { taskType: "code" });

    const other = await open(home, T0 + 4 * HOUR);
    const mine = { ...search, inheritedProviderInstanceId: "cursor", inheritedModel: "claude-opus-9-2" };
    out["another orchestrator merges its search after a restart"] = await recommend(other, {
      taskType: "code",
      capabilities: mine,
      mergeCapabilities: true,
    });
    out["capabilities-cache.json after that merge"] = other.file("capabilities-cache.json");
    out["expired after 12 h"] = await recommend(await open(home, T0 + 3.1 * HOUR + 12.5 * HOUR), {
      taskType: "code",
    });

    const truncated = await open();
    const cursorSearch = driverFixtureRaw("search-cursor-gemini") as { providers: { omittedModels?: number }[] };
    cursorSearch.providers[0]!.omittedModels = 9;
    out["cursor alone"] = await recommend(truncated, { taskType: "review", capabilities: driverFixtureRaw("cursor") });
    out["merge a search that left models out"] = await recommend(truncated, {
      taskType: "review",
      capabilities: cursorSearch,
      mergeCapabilities: true,
    });

    const lone = await open();
    out["a lone search with mergeCapabilities"] = await recommend(lone, {
      taskType: "code",
      capabilities: search,
      mergeCapabilities: true,
    });
    out["nothing kept after it"] = await recommend(lone, { taskType: "code" });
    out["a list of outputs"] = await recommend(await open(), { taskType: "code", capabilities: [mixed, search] });
    out["a list of JSON strings, for merging"] = await recommend(await open(), {
      taskType: "code",
      capabilities: [JSON.stringify(mixed), JSON.stringify(search)],
      mergeCapabilities: true,
    });
    out["the whole list as one JSON string"] = await recommend(await open(), {
      taskType: "code",
      capabilities: JSON.stringify([mixed, search]),
    });
    out["a JSON string"] = await recommend(await open(), { taskType: "code", capabilities: JSON.stringify(mixed) });
    out["a bare providers array"] = await recommend(await open(), {
      taskType: "code",
      capabilities: (mixed as { providers: unknown[] }).providers,
    });

    const together = await open();
    out["calls sent at once"] = await Promise.all([
      recommend(together, { taskType: "code", capabilities: mixed }),
      recommend(together, { taskType: "review" }),
      recommend(together, { taskType: "quick" }),
    ]);

    const ttl = await open();
    writeFileSync(join(ttl.home, "policy.yaml"), "capabilitiesCacheTtlHours: 1\nmaxCandidates: 2\nmaxCandidatez: 1\n");
    out["a user policy: TTL 1 h, two candidates and a misspelt key"] = await recommend(ttl, {
      taskType: "code",
      capabilities: mixed,
    });
    out["its copy, read 1.5 h later"] = await recommend(await open(ttl.home, T0 + 1.5 * HOUR), { taskType: "code" });
    const noDemote = await open();
    writeFileSync(
      join(noDemote.home, "policy.yaml"),
      "taskTypes:\n  quick:\n    candidates:\n      - { provider: codex, family: gpt, effort: low, noDemote: true, options: { fastMode: true } }\n      - { provider: '*', family: claude-opus, effort: max }\n",
    );
    out["a user policy with noDemote and options"] = await recommend(noDemote, {
      taskType: "quick",
      capabilities: raw("capabilities.json"),
      usage: [
        { providerInstanceId: "codex", windows: [{ kind: "weekly", usedPercent: 90 }] },
        {
          providerInstanceId: "claudeAgent",
          windows: [{ kind: "weekly", usedPercent: 76, modelIds: ["claude-opus-7-1"] }],
        },
      ],
    });
    const excluded = await open();
    writeFileSync(join(excluded.home, "policy.yaml"), "excludeProviders: [codex, cursor]\ngenericFallback: false\n");
    out["a user policy that excludes providers"] = await recommend(excluded, {
      taskType: "code",
      capabilities: mixed,
    });
    await expect(json(out)).toMatchFileSnapshot("./golden/capabilities-flow.json");
  });

  it("the log and the statistics", async () => {
    const s = await open();
    const out: Record<string, unknown> = {};
    out["log_delegation with every field"] = await s.call("log_delegation", {
      taskType: "code",
      providerInstanceId: "codex",
      model: "gpt-6.2-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
      recommendedRank: 1,
      childThreadId: "thread:child-1",
      summary: `CSV export endpoint ${"and more ".repeat(30)}`,
    });
    out["log_delegation with an alias and no rank"] = await s.call("log_delegation", {
      taskType: "fix",
      providerInstanceId: "claudeAgent",
      model: "claude-opus-7-1",
      recommendedRank: null,
    });
    out["log_delegation with a rank of 2"] = await s.call("log_delegation", {
      taskType: "review",
      providerInstanceId: "cursor",
      model: "gemini-4-neon",
      recommendedRank: 2,
    });
    // The results show the ids as placeholders: the outcomes take the real ones from the log.
    const realIds = readFileSync(join(s.home, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { id: string }).id);
    out["log_outcome with a delegationId"] = await s.call("log_outcome", {
      delegationId: realIds[0],
      outcome: "success",
      note: "accepted as is",
    });
    out["log_outcome corrected"] = await s.call("log_outcome", { delegationId: realIds[1], outcome: "corrected" });
    out["log_outcome on its own"] = await s.call("log_outcome", {
      taskType: "review",
      providerInstanceId: "grok",
      model: "grok-8.1",
      outcome: "failure",
      note: "missed the bug",
    });
    out["mark one model"] = await s.call("mark_unavailable", {
      providerInstanceId: "cursor",
      model: "gemini-4-neon",
      reason: "not included in your weekly usage",
      until: "2026-11-22T09:00:00Z",
    });
    out.get_stats = await s.call("get_stats");
    out["get_stats since 2000-01-01"] = await s.call("get_stats", { since: "2000-01-01" });
    out["get_stats since 2999-01-01"] = await s.call("get_stats", { since: "2999-01-01" });
    out["get_stats for code"] = await s.call("get_stats", { taskType: "code" });
    out["get_stats for a type with no record"] = await s.call("get_stats", { taskType: "design" });
    out["log.jsonl"] = s.file("log.jsonl");
    out["unavailable.json"] = s.file("unavailable.json");
    await expect(json(out)).toMatchFileSnapshot("./golden/log-and-stats.json");
  });

  it("error messages", async () => {
    const s = await open();
    const caps = raw("capabilities.json");
    const out: Record<string, unknown> = {};
    out["no capabilities yet"] = await recommend(s, { taskType: "code" });
    out["capabilities: not JSON"] = await recommend(s, { taskType: "code", capabilities: "{bad" });
    out["capabilities: no providers key"] = await recommend(s, { taskType: "code", capabilities: { foo: 1 } });
    out["capabilities: a list item that is not JSON"] = await recommend(s, {
      taskType: "code",
      capabilities: ["{bad"],
    });
    out["capabilities: an empty providers list"] = await recommend(s, {
      taskType: "code",
      capabilities: { providers: [] },
    });
    out["every provider disabled"] = await recommend(s, {
      taskType: "code",
      capabilities: driverFixtureRaw("all-disabled"),
    });
    out["unknown taskType"] = await recommend(s, { taskType: "frobnicate", capabilities: caps });
    out["prototype key as taskType"] = await recommend(s, { taskType: "constructor" });
    out["log_delegation: unknown taskType"] = await s.call("log_delegation", {
      taskType: "frobnicate",
      providerInstanceId: "codex",
      model: "m",
    });
    out["log_outcome: neither delegationId nor the three fields"] = await s.call("log_outcome", {
      taskType: "code",
      outcome: "success",
    });
    out["log_outcome: unknown delegationId"] = await s.call("log_outcome", {
      delegationId: "d_000000000000",
      outcome: "success",
    });
    out["log_outcome: unknown taskType"] = await s.call("log_outcome", {
      taskType: "__proto__",
      providerInstanceId: "a",
      model: "m",
      outcome: "success",
    });
    out["mark_unavailable: no reason"] = await s.call("mark_unavailable", { providerInstanceId: "codex" });
    out["mark_unavailable: until in the past"] = await s.call("mark_unavailable", {
      providerInstanceId: "codex",
      reason: "limit",
      until: "2026-11-20T00:00:00Z",
    });
    out["mark_unavailable: until is not a date"] = await s.call("mark_unavailable", {
      providerInstanceId: "codex",
      reason: "limit",
      until: "soon",
    });
    out["set_subscription: no plan or quota"] = await s.call("set_subscription", { providerInstanceId: "codex" });
    out["set_subscription: unknown names"] = await s.call("set_subscription", {
      providerInstanceId: "codex",
      plan: "ChatGPT Plus",
      quota: "standard",
      onlyFamilies: ["gemmini"],
      onlyTaskTypes: ["reviews"],
    });
    out["set_subscription: invalid values"] = await s.call("set_subscription", {
      providerInstanceId: "codex",
      plan: " ",
      quota: "standard",
      onlyFamilies: ["gpt"],
      avoidFamilies: ["gemini"],
      includedFamilies: ["gpt", "gpt"],
    });
    out["set_subscription: remove with other fields"] = await s.call("set_subscription", {
      providerInstanceId: "codex",
      remove: true,
      plan: "x",
    });
    out["get_stats: since is not a date"] = await s.call("get_stats", { since: "not a date" });

    const broken = await open();
    writeFileSync(join(broken.home, "policy.yaml"), "maxCandidates: 9\n");
    out["an invalid user policy"] = await recommend(broken, { taskType: "code", capabilities: caps });
    out["an invalid user policy: log_delegation"] = await broken.call("log_delegation", {
      taskType: "code",
      providerInstanceId: "codex",
      model: "m",
    });
    writeFileSync(
      join(broken.home, "policy.yaml"),
      "taskTypes:\n  code:\n    candidates:\n      - { provider: codex, family: nope }\n",
    );
    out["a user policy with an unknown family"] = await recommend(broken, { taskType: "code", capabilities: caps });
    await expect(json(out)).toMatchFileSnapshot("./golden/errors.json");
  });
});

describe("golden: the command line", () => {
  const saved = process.env.T3_AUTOPILOT_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.T3_AUTOPILOT_HOME;
    else process.env.T3_AUTOPILOT_HOME = saved;
  });

  async function run(...argv: string[]) {
    let out = "";
    let err = "";
    const code = await runCli(argv, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  }
  const versionless = (s: string) => s.split(VERSION).join("<version>");

  it("snippet, help, an unknown command and init-policy", async () => {
    const snippet = await run("snippet");
    expect(snippet).toMatchObject({ code: 0, err: "" });
    await expect(snippet.out).toMatchFileSnapshot("./golden/cli-snippet.md");
    const help = await run("--help");
    expect(help).toMatchObject({ code: 0, err: "" });
    await expect(versionless(help.out)).toMatchFileSnapshot("./golden/cli-help.txt");

    const home = tempDir();
    process.env.T3_AUTOPILOT_HOME = home;
    const normalize = normalizer(home);
    const first = await run("init-policy");
    await expect(readFileSync(join(home, "policy.yaml"), "utf8")).toMatchFileSnapshot("./golden/cli-init-policy.yaml");
    const unknown = await run("frobnicate");
    const out = {
      "unknown command": { ...unknown, err: versionless(unknown.err) },
      "init-policy": normalize(first),
      "init-policy again": normalize(await run("init-policy")),
    };
    await expect(json(out)).toMatchFileSnapshot("./golden/cli.json");
  });
});
