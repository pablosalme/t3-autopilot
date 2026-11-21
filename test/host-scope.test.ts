import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { helpText, runCli } from "../src/cliMain.js";
import {
  allHostsSnippet,
  DEFAULT_HOST,
  HOSTS,
  resolveHost,
  splitKey,
  splitOwn,
  storageKey,
  viewItems,
  viewKey,
  viewOf,
  viewPolicy,
} from "../src/hosts/index.js";
import { t3 } from "../src/hosts/t3.js";
import type { HostAdapter } from "../src/hosts/types.js";
import type { Candidate, Recommendation } from "../src/recommend.js";
import { INSTRUCTIONS_SNIPPET } from "../src/snippet.js";
import { fake, fakePayload } from "./fakeHost.js";
import { connectServer, driverFixtureRaw, policyWith, resultText, tempDir } from "./helpers.js";

type Result = Recommendation & { host?: string; capabilitiesFrom: string };

const T0 = new Date("2026-11-21T09:00:00Z");
const HOSTS2 = [t3, fake];

/** T3's catalog (codex, cursor, opencode, kiro, pi; the orchestrator on codex). */
const t3Caps = () => driverFixtureRaw("mixed");
/** Fake Host's catalog: agents named like T3's provider instances, on purpose. */
const fakeCaps = () =>
  fakePayload(
    [
      { id: "codex", driver: "codex", models: ["gpt-9.1-sol"] },
      { id: "claude", driver: "claudeAgent", models: ["claude-opus-9-1"] },
    ],
    { agent: "claude", model: "claude-opus-9-1" },
  );

/** A server that knows T3 and the fake host, on `home`, with a fixed clock. */
async function connect(home = tempDir(), hosts: readonly HostAdapter[] = HOSTS2) {
  const { client } = await connectServer(home, { hosts, now: () => T0 });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    expect((res as { isError?: boolean }).isError, `${name}: ${resultText(res)}`).toBeFalsy();
    return res.structuredContent as Record<string, unknown>;
  };
  const failure = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    expect((res as { isError?: boolean }).isError).toBe(true);
    return resultText(res);
  };
  const recommend = async (args: Record<string, unknown>) =>
    (await call("recommend_model", { task: "x", taskType: "code", ...args })) as unknown as Result;
  return { client, home, call, failure, recommend };
}

const ids = (r: { candidates: Candidate[] }) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
const file = (home: string, name: string) => readFileSync(join(home, name), "utf8");

describe("keys per host", () => {
  it("T3 stores its ids as they are; another host with its prefix", () => {
    expect(storageKey(t3, "codex")).toBe("codex");
    expect(storageKey(fake, "codex")).toBe("fake:codex");
    expect(splitKey("codex")).toEqual({ host: "t3", id: "codex" });
    expect(splitKey("fake:codex")).toEqual({ host: "fake", id: "codex" });
    expect(splitKey("orca:a:b")).toEqual({ host: "orca", id: "a:b" });
    // T3's ids never have ":", but whatever T3 stored reads back whole, as in 0.1.
    expect(splitKey("t3:codex")).toEqual({ host: "t3", id: "t3:codex" });
    expect(splitKey(":x")).toEqual({ host: "t3", id: ":x" });
  });

  it("T3 sees every stored key as it is; another host sees its own bare and the rest prefixed", () => {
    for (const key of ["codex", "fake:codex", "orca:codex", "t3:codex", "a:b:c", ":x"]) {
      expect(viewKey(t3, key)).toBe(key);
    }
    expect(viewKey(fake, "fake:codex")).toBe("codex");
    expect(viewKey(fake, "codex")).toBe("t3:codex");
    expect(viewKey(fake, "orca:codex")).toBe("orca:codex");
    for (const id of ["codex", "a:b", "t3:x"]) {
      expect(viewKey(fake, storageKey(fake, id))).toBe(id);
      expect(viewKey(t3, storageKey(t3, id))).toBe(id);
    }
  });

  it("views records, items and the policy's ids for a host", () => {
    const all = { codex: 1, "fake:codex": 2, "orca:x": 3 };
    expect(viewOf(t3, all)).toEqual(all);
    expect(viewOf(fake, all)).toEqual({ "t3:codex": 1, codex: 2, "orca:x": 3 });
    expect(splitOwn(fake, all)).toEqual({ own: { codex: 2 }, others: { "t3:codex": 1, "orca:x": 3 } });
    expect(splitOwn(t3, all)).toEqual({ own: { codex: 1 }, others: { "fake:codex": 2, "orca:x": 3 } });
    expect(viewItems(fake, [{ providerInstanceId: "codex", n: 1 }])).toEqual([
      { providerInstanceId: "t3:codex", n: 1 },
    ]);

    const policy = policyWith({
      excludeProviders: ["codex", "fake:cursor"],
      fallback: [
        { instance: "fake:codex", family: "gpt" },
        { provider: "*", family: "gpt" },
      ],
    });
    const seen = viewPolicy(fake, policy);
    expect(seen.excludeProviders).toEqual(["t3:codex", "cursor"]);
    expect(seen.fallback.map((r) => r.instance)).toEqual(["codex", undefined]);
    expect(viewPolicy(t3, policy)).toEqual(policy);
  });

  it("resolves the host: named, then by the payload's shape, then the last one, then the default", () => {
    expect(resolveHost({}, HOSTS2)).toBe(t3);
    expect(resolveHost({ host: "fake" }, HOSTS2)).toBe(fake);
    expect(resolveHost({ payload: fakeCaps() }, HOSTS2)).toBe(fake);
    expect(resolveHost({ payload: t3Caps(), last: fake }, HOSTS2)).toBe(t3);
    expect(resolveHost({ last: fake }, HOSTS2)).toBe(fake);
    expect(resolveHost({ payload: 42, last: fake }, HOSTS2)).toBe(fake);
    expect(resolveHost({})).toBe(DEFAULT_HOST);
    expect(() => resolveHost({ host: "orca" }, HOSTS2)).toThrow('Unknown host "orca". Known hosts: t3, fake.');
    expect(() => resolveHost({ host: "t3", payload: fakeCaps() }, HOSTS2)).toThrow(
      'host is "t3", but capabilities look like Fake Host output (host "fake").',
    );
    // A payload no host recognises goes to the named host, whose parser says what is wrong.
    expect(resolveHost({ host: "fake", payload: 42 }, HOSTS2)).toBe(fake);
  });
});

describe("recommend_model with two hosts", () => {
  it("tells the host from the payload, says it outside T3, and keeps each host's capabilities apart", async () => {
    const s = await connect();
    const mine = await s.recommend({ capabilities: t3Caps() });
    expect(mine.host).toBeUndefined();
    const theirs = await s.recommend({ capabilities: fakeCaps() });
    expect(theirs.host).toBe("fake");
    expect(ids(theirs)[0]).toBe("claude/claude-opus-9-1");
    // The last host was fake: a call with nothing to tell it apart is fake's; T3 must say so.
    expect((await s.recommend({})).host).toBe("fake");
    const back = await s.recommend({ host: "t3" });
    expect(back.capabilitiesFrom).toBe("cache");
    expect(ids(back)).toEqual(ids(mine));
    expect(await s.failure("recommend_model", { task: "x", host: "t3", capabilities: fakeCaps() })).toBe(
      'host is "t3", but capabilities look like Fake Host output (host "fake"). Pass the host you run in and the ' +
        "output of that host.",
    );
    expect(await s.failure("recommend_model", { task: "x", host: "orca" })).toMatch(/host/);
  });

  it("a host with a launch command adds it to each candidate, and skips the ones it cannot start", async () => {
    const launcher: HostAdapter = {
      ...fake,
      launch: (c) => {
        if (c.model === "claude-opus-9-1") throw new Error("not on this machine");
        return { mode: "supervised", agent: c.providerInstanceId, args: ["--agent", c.providerInstanceId], argv: [] };
      },
    };
    const s = await connect(tempDir(), [t3, launcher]);
    const res = await s.recommend({ capabilities: fakeCaps() });
    expect(
      res.candidates.map((c) => [c.providerInstanceId, (c as { launch?: { args: string[] } }).launch?.args]),
    ).toEqual([["codex", ["--agent", "codex"]]]);
    expect(res.skipped).toContain("claude/claude-opus-9-1: not on this machine");
    // T3 has no launch: its candidates stay as they were.
    expect((await s.recommend({ capabilities: t3Caps() })).candidates[0]).not.toHaveProperty("launch");
  });
});

describe("marks, profiles, the log and the policy per host", () => {
  it("a mark of the fake host is stored with its prefix and changes nothing in T3", async () => {
    const s = await connect();
    const before = await s.recommend({ capabilities: t3Caps(), host: "t3" });
    const marked = await s.call("mark_unavailable", {
      host: "fake",
      providerInstanceId: "codex",
      reason: "weekly limit",
      until: "2026-11-22T09:00:00Z",
    });
    expect(marked.marked).toMatchObject({ providerInstanceId: "codex", reason: "weekly limit" });
    expect(marked.active).toEqual([marked.marked]);
    expect(
      JSON.parse(file(s.home, "unavailable.json")).marks.map(
        (m: { providerInstanceId: string }) => m.providerInstanceId,
      ),
    ).toEqual(["fake:codex"]);
    expect(await s.recommend({ capabilities: t3Caps(), host: "t3" })).toEqual(before);
    // T3's own marks list does not show it; the fake host's recommendation moves codex after the rest.
    const t3Clear = await s.call("mark_unavailable", { host: "t3", providerInstanceId: "nobody", clear: true });
    expect(t3Clear).toEqual({ cleared: [], active: [] });
    const theirs = await s.recommend({ capabilities: fakeCaps(), taskType: "review" });
    expect(theirs.candidates.find((c) => c.providerInstanceId === "codex")?.reason).toMatch(
      /marked unavailable until 2026-11-22T09:00:00.000Z: weekly limit/,
    );
    // And a mark of T3 does nothing to the fake host's codex.
    const s2 = await connect();
    const fakeBefore = await s2.recommend({ capabilities: fakeCaps(), taskType: "review" });
    await s2.call("mark_unavailable", { host: "t3", providerInstanceId: "codex", reason: "limit" });
    expect(await s2.recommend({ capabilities: fakeCaps(), taskType: "review" })).toEqual(fakeBefore);
    const cleared = await s2.call("mark_unavailable", { host: "fake", providerInstanceId: "codex", clear: true });
    expect(cleared.cleared).toEqual([]);
    expect(JSON.parse(file(s2.home, "unavailable.json")).marks).toHaveLength(1);
  });

  it("profiles: each host saves under its own keys and sees the others apart, in otherHosts", async () => {
    const s = await connect();
    const t3Before = await s.recommend({ capabilities: t3Caps(), host: "t3" });
    const saved = await s.call("set_subscription", {
      host: "fake",
      providerInstanceId: "codex",
      plan: "ChatGPT Plus",
      quota: "tight",
      role: "experimental",
    });
    expect(saved.saved).toMatchObject({ providerInstanceId: "codex", plan: "ChatGPT Plus" });
    expect(Object.keys(saved.subscriptions as object)).toEqual(["codex"]);
    expect(saved.otherHosts).toBeUndefined();
    expect(Object.keys(parse(file(s.home, "subscriptions.yaml")).subscriptions)).toEqual(["fake:codex"]);
    expect(await s.recommend({ capabilities: t3Caps(), host: "t3" })).toEqual(t3Before);

    await s.call("set_subscription", {
      host: "t3",
      providerInstanceId: "codex",
      plan: "ChatGPT Pro",
      quota: "generous",
    });
    const mine = await s.call("get_subscriptions", { host: "t3" });
    expect(Object.keys(mine.subscriptions as object)).toEqual(["codex"]);
    expect((mine.subscriptions as Record<string, { plan: string }>).codex?.plan).toBe("ChatGPT Pro");
    expect(Object.keys(mine.otherHosts as object)).toEqual(["fake:codex"]);
    expect(mine.missing).toEqual(["cursor", "opencode", "kiro", "pi"]);
    const theirs = await s.call("get_subscriptions", { host: "fake" });
    expect((theirs.subscriptions as Record<string, { plan: string }>).codex?.plan).toBe("ChatGPT Plus");
    expect(Object.keys(theirs.otherHosts as object)).toEqual(["t3:codex"]);
    // T3's capabilities are kept, the fake host's are not yet.
    expect(theirs.missing).toBeNull();
    // setupNeeded asks each host only about its own providers.
    const fakeRec = await s.recommend({ capabilities: fakeCaps() });
    expect(fakeRec.setupNeeded?.providers.map((p) => p.providerInstanceId)).toEqual(["claude"]);
    expect((await s.call("get_subscriptions", { host: "fake" })).missing).toEqual(["claude"]);

    const removed = await s.call("set_subscription", { host: "fake", providerInstanceId: "codex", remove: true });
    expect(removed.removed).toMatchObject({ providerInstanceId: "codex", plan: "ChatGPT Plus" });
    expect(Object.keys(removed.otherHosts as object)).toEqual(["t3:codex"]);
    expect(Object.keys(parse(file(s.home, "subscriptions.yaml")).subscriptions)).toEqual(["codex"]);
  });

  it("a quota pool shared between T3 and the fake host carries a mark both ways", async () => {
    const s = await connect();
    await s.call("set_subscription", {
      host: "t3",
      providerInstanceId: "codex",
      plan: "ChatGPT Plus",
      quota: "standard",
      quotaPool: "chatgpt",
      quotaWindow: "weekly",
    });
    const mate = await s.call("set_subscription", {
      host: "fake",
      providerInstanceId: "codex",
      plan: "ChatGPT Plus",
      quota: "standard",
      quotaPool: "chatgpt",
    });
    expect(mate.warnings).toEqual([]);
    // No window of its own: the T3 mate's lends it, and the result names it as the fake host sees it.
    const marked = await s.call("mark_unavailable", { host: "fake", providerInstanceId: "codex", reason: "limit" });
    expect(marked.untilFrom).toBe("quotaWindow weekly of t3:codex's subscription profile");
    // T3's codex goes after the providers that are not marked, and with codex alone it says why.
    const mixed = await s.recommend({ capabilities: t3Caps(), host: "t3" });
    expect(ids(mixed)[0]).not.toMatch(/^codex\//);
    expect(mixed.skipped).toContain(
      "fake:codex (every model): marked unavailable until 2026-11-28T09:00:00.000Z (limit)",
    );
    const alone = await s.recommend({ capabilities: driverFixtureRaw("codex"), host: "t3" });
    expect(alone.candidates[0]?.reason).toMatch(
      /shares quota pool "chatgpt" with fake:codex, marked unavailable until 2026-11-28T09:00:00.000Z: limit; quota may be exhausted/,
    );
    await s.call("mark_unavailable", { host: "fake", providerInstanceId: "codex", clear: true });
    await s.call("mark_unavailable", { host: "t3", providerInstanceId: "codex", reason: "limit" });
    const theirs = await s.recommend({
      capabilities: fakePayload([{ id: "codex", driver: "codex", models: ["gpt-9.1-sol"] }]),
    });
    expect(theirs.candidates[0]?.reason).toMatch(/shares quota pool "chatgpt" with t3:codex, marked unavailable/);
  });

  it("without a shared pool, the same provider id on two hosts shares nothing", async () => {
    const s = await connect();
    await s.call("set_subscription", { host: "t3", providerInstanceId: "codex", plan: "A", quota: "standard" });
    await s.call("set_subscription", { host: "fake", providerInstanceId: "codex", plan: "B", quota: "standard" });
    await s.call("mark_unavailable", { host: "t3", providerInstanceId: "codex", reason: "limit" });
    const theirs = await s.recommend({ capabilities: fakeCaps(), taskType: "review" });
    expect(theirs.candidates.some((c) => /marked unavailable|quota pool/.test(c.reason))).toBe(false);
  });

  it("the log stores each host's records under its keys, and get_stats keeps them apart", async () => {
    const s = await connect();
    const del = await s.call("log_delegation", {
      host: "fake",
      taskType: "code",
      providerInstanceId: "codex",
      model: "gpt-9.1-sol",
      recommendedRank: 1,
      childThreadId: "t7",
    });
    expect(del.logged).toMatchObject({ providerInstanceId: "codex", host: "fake", childThreadId: "t7" });
    await s.call("log_outcome", { delegationId: del.delegationId, outcome: "success" });
    const alone = await s.call("log_outcome", {
      host: "fake",
      taskType: "review",
      providerInstanceId: "claude",
      model: "claude-opus-9-1",
      outcome: "failure",
    });
    expect(alone.logged).toMatchObject({ providerInstanceId: "claude", host: "fake" });
    await s.call("log_delegation", { host: "t3", taskType: "code", providerInstanceId: "codex", model: "gpt-9.1-sol" });
    await s.call("mark_unavailable", { host: "fake", providerInstanceId: "claude", reason: "plan" });

    const lines = file(s.home, "log.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((r) => [r.providerInstanceId, r.host])).toEqual([
      ["fake:codex", "fake"],
      [undefined, undefined],
      ["fake:claude", "fake"],
      ["codex", undefined],
    ]);
    const all = await s.call("get_stats");
    expect(Object.keys(all.byModel as object).sort()).toEqual([
      "codex/gpt-9.1-sol",
      "fake:claude/claude-opus-9-1",
      "fake:codex/gpt-9.1-sol",
    ]);
    expect(all).not.toHaveProperty("host");
    const theirs = await s.call("get_stats", { host: "fake" });
    expect(theirs.host).toBe("fake");
    expect(Object.keys(theirs.byModel as object).sort()).toEqual([
      "fake:claude/claude-opus-9-1",
      "fake:codex/gpt-9.1-sol",
    ]);
    expect(theirs.total).toMatchObject({ delegations: 2, success: 1, failure: 1 });
    expect((theirs.unavailable as unknown[]).length).toBe(1);
    const mine = await s.call("get_stats", { host: "t3", taskType: "code" });
    expect(mine).toMatchObject({
      host: "t3",
      taskType: "code",
      stats: { delegations: 1, pending: 1 },
      unavailable: [],
    });
  });

  it("excludeProviders and instance rules name another host's ids with its prefix", async () => {
    const home = tempDir();
    writeFileSync(
      join(home, "policy.yaml"),
      "excludeProviders: [fake:codex, kiro]\n" +
        "taskTypes:\n  code:\n    candidates:\n      - { instance: 'fake:claude', family: claude-opus, effort: max }\n" +
        "      - { instance: claude, family: claude-opus, effort: low }\n",
    );
    const s = await connect(home);
    const mine = await s.recommend({ capabilities: t3Caps(), host: "t3" });
    expect(mine.skipped).toContain("kiro: listed in excludeProviders");
    expect(mine.skipped.some((x) => x.startsWith("codex:"))).toBe(false);
    const theirs = await s.recommend({ capabilities: fakeCaps() });
    expect(theirs.skipped).toContain("codex: listed in excludeProviders");
    expect(theirs.candidates[0]).toMatchObject({
      providerInstanceId: "claude",
      reason:
        "code #1: latest claude-opus on claude is claude-opus-9-1, effort high (effort max not supported, using high)",
    });
  });

  it("a call that names no host is for the last recommend_model call's host", async () => {
    const s = await connect();
    await s.recommend({ capabilities: fakeCaps() });
    await s.call("mark_unavailable", { providerInstanceId: "codex", reason: "limit" });
    await s.call("log_delegation", { taskType: "code", providerInstanceId: "codex", model: "gpt-9.1-sol" });
    expect(JSON.parse(file(s.home, "unavailable.json")).marks[0].providerInstanceId).toBe("fake:codex");
    expect(JSON.parse(file(s.home, "log.jsonl").trim()).providerInstanceId).toBe("fake:codex");
  });
});

describe("snippet --host", () => {
  async function run(argv: string[], hosts: readonly HostAdapter[] = HOSTS2) {
    let out = "";
    let err = "";
    const code = await runCli(argv, { out: (s) => (out += s), err: (s) => (err += s) }, hosts);
    return { code, out, err };
  }

  it("prints a host's snippet, and exits with 2 without a host or with an unknown one", async () => {
    expect(await run(["snippet", "--host", "fake"])).toEqual({ code: 0, out: fake.snippet, err: "" });
    expect(await run(["snippet", "--host", "t3"])).toEqual({ code: 0, out: INSTRUCTIONS_SNIPPET, err: "" });
    expect(await run(["snippet"])).toEqual({ code: 0, out: INSTRUCTIONS_SNIPPET, err: "" });
    expect(await run(["snippet", "--host"])).toEqual({
      code: 2,
      out: "",
      err: "snippet --host needs a host: t3, fake, or all for every host.\n",
    });
    expect(await run(["snippet", "--host", "orca"])).toEqual({
      code: 2,
      out: "",
      err: 'Unknown host "orca". Known hosts: t3, fake, or all for every host.\n',
    });
    expect((await run(["snippet", "--host", "t3"], [t3])).out).toBe(INSTRUCTIONS_SNIPPET);
  });

  it("--host all says how to find your host, then gives every registered host's instructions", async () => {
    const all = await run(["snippet", "--host", "all"]);
    expect(all).toEqual({ code: 0, out: allHostsSnippet(HOSTS2), err: "" });
    expect(all.out).toBe(
      [
        "## Model selection for delegated tasks, in every host (t3-autopilot)",
        "",
        "These instructions cover every host t3-autopilot supports. First find the one you run in, the first of " +
          "these that applies, then follow only its section:",
        "",
        "- T3 Code: you have the `orchestrator_capabilities` tool.",
        "- Fake Host: you can run `fake-agents`.",
        "",
        "If none of them applies, do not call t3-autopilot.",
        "",
        "### T3 Code",
        "",
        INSTRUCTIONS_SNIPPET.slice(INSTRUCTIONS_SNIPPET.indexOf("\n\n") + 2),
        "### Fake Host",
        "",
        "Call recommend_model with host: fake.",
        "",
      ].join("\n"),
    );
    // A host added to the registry is in it at once, after the others: herdr's, and Orca's once it is registered.
    const three = await run(["snippet", "--host", "all"], [...HOSTS, fake]);
    const order = ["### T3 Code", "### herdr", "### Fake Host"].map((h) => three.out.indexOf(`\n${h}\n`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    for (const host of [...HOSTS, fake]) expect(three.out).toContain(`- ${host.name}: ${host.recognize}.`);
    // With one host, its own snippet.
    expect((await run(["snippet", "--host", "all"], [t3])).out).toBe(INSTRUCTIONS_SNIPPET);
  });

  it("the help lists --host once there is another host", async () => {
    expect(helpText([t3])).not.toContain("--host");
    expect(helpText(HOSTS2)).toContain(
      "  t3-autopilot snippet --host <id> Print another host's instructions (fake), or every host's (all).\n" +
        "  t3-autopilot init-policy",
    );
    expect((await run(["--help"])).out).toBe(helpText(HOSTS2));
    expect((await run(["frobnicate"])).err).toContain("snippet --host <id>");
  });
});

describe("T3 Code as the only host", () => {
  it("the tools take host t3 and refuse any other", async () => {
    const { client } = await connectServer(tempDir(), { now: () => T0, hosts: [t3] });
    const ok = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", host: "t3", capabilities: t3Caps() },
    });
    expect(ok.isError, resultText(ok)).toBeFalsy();
    expect(ok.structuredContent).not.toHaveProperty("host");
    const other = await client
      .callTool({ name: "get_subscriptions", arguments: { host: "fake" } })
      .catch((e: unknown) => ({ isError: true, thrown: e }));
    expect(other.isError).toBe(true);
    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === "mark_unavailable")?.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(schema.properties.host?.enum).toEqual(["t3"]);
    expect(schema.required).toEqual(["providerInstanceId"]);
  });

  it("a host's view helpers leave T3's data as it is (0.1 files)", async () => {
    const s = await connect(tempDir(), [t3]);
    await s.call("set_subscription", { providerInstanceId: "codex", plan: "ChatGPT Pro", quota: "generous" });
    const got = await s.call("get_subscriptions");
    expect(Object.keys(got)).toEqual(["file", "subscriptions", "missing"]);
  });
});

/** Every host in a list is told apart by its own payload, and none takes another's. */
describe("detect", () => {
  it("T3 and the fake host do not take each other's payload", () => {
    const payloads = [t3Caps(), fakeCaps()];
    expect(payloads.map((p) => HOSTS2.filter((h) => h.detect(p)).map((h) => h.id))).toEqual([["t3"], ["fake"]]);
  });
});
