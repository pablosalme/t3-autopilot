import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { t3 } from "../../src/hosts/t3.js";
import { computeStats, readLog } from "../../src/log.js";
import { readSubscriptions, writeSubscriptions } from "../../src/subscriptions.js";
import { activeMarks, markUnavailable } from "../../src/unavailable.js";
import { fake, fakePayload } from "../fakeHost.js";
import { connectServer, driverFixtureRaw, resultText, tempDir } from "../helpers.js";
import { CacheFileSchema, MarksFileSchema, readLog013, SubscriptionsFileSchema } from "./schemas-0.1.3.js";

// Compatibility with 0.1.x both ways: what this version writes passes 0.1.3's schemas, and files 0.1.3 wrote
// read the same. Both kinds of server share ~/.t3-autopilot (an `npx -y` in one session and another in the next).

const T0 = new Date("2026-11-21T09:00:00Z");
const FIXTURES = new URL("../fixtures/compat-0.1.3/", import.meta.url);

async function connect(home: string) {
  const { client } = await connectServer(home, { hosts: [t3, fake], now: () => T0 });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    expect((res as { isError?: boolean }).isError, `${name}: ${resultText(res)}`).toBeFalsy();
    return res.structuredContent as Record<string, unknown>;
  };
  return { client, call, read: (name: string) => readFileSync(join(home, name), "utf8") };
}

/** A data directory holding the files a 0.1.3 server wrote (test/fixtures/compat-0.1.3). */
function written013(): string {
  const home = tempDir();
  for (const name of readdirSync(FIXTURES)) copyFileSync(new URL(name, FIXTURES), join(home, name));
  return home;
}

const fakeCaps = fakePayload([
  { id: "codex", driver: "codex", models: ["gpt-9.1-sol"] },
  { id: "claude", driver: "claudeAgent", models: ["claude-opus-9-1"] },
]);

describe("files written now, read by 0.1.3", () => {
  it("pass 0.1.3's schemas with another host's entries in them", async () => {
    const home = tempDir();
    const s = await connect(home);
    await s.call("recommend_model", { task: "x", taskType: "code", capabilities: driverFixtureRaw("mixed") });
    await s.call("recommend_model", { task: "x", taskType: "code", capabilities: fakeCaps });
    for (const host of ["t3", "fake"]) {
      await s.call("set_subscription", {
        host,
        providerInstanceId: "codex",
        plan: "ChatGPT Plus",
        quota: "standard",
        quotaPool: "chatgpt",
      });
    }
    await s.call("mark_unavailable", { host: "fake", providerInstanceId: "codex", reason: "limit" });
    await s.call("mark_unavailable", { host: "t3", providerInstanceId: "cursor", model: "gemini-9", reason: "plan" });
    await s.call("log_delegation", {
      host: "fake",
      taskType: "code",
      providerInstanceId: "codex",
      model: "gpt-9.1-sol",
    });
    await s.call("log_outcome", {
      host: "fake",
      taskType: "review",
      providerInstanceId: "claude",
      model: "claude-opus-9-1",
      outcome: "success",
    });
    await s.call("log_delegation", { host: "t3", taskType: "code", providerInstanceId: "codex", model: "gpt-9.1-sol" });

    const subs = SubscriptionsFileSchema.safeParse(parse(s.read("subscriptions.yaml")));
    expect(subs.success, subs.error?.message).toBe(true);
    expect(Object.keys(subs.data?.subscriptions ?? {})).toEqual(["codex", "fake:codex"]);
    const marks = MarksFileSchema.safeParse(JSON.parse(s.read("unavailable.json")));
    expect(marks.success, marks.error?.message).toBe(true);
    expect(marks.data?.marks.map((m) => m.providerInstanceId)).toEqual(["fake:codex", "cursor"]);
    // The file 0.1.3 reads holds T3's capabilities only: the fake host's never reach it.
    const cache = CacheFileSchema.safeParse(JSON.parse(s.read("capabilities-cache.json")));
    expect(cache.success, cache.error?.message).toBe(true);
    expect(cache.data?.capabilities.providers.map((p) => p.providerInstanceId)).toEqual([
      "codex",
      "cursor",
      "opencode",
      "kiro",
      "pi",
    ]);
    const records = readLog013(s.read("log.jsonl"));
    expect(records.map((r) => [r.kind, r.providerInstanceId])).toEqual([
      ["delegation", "fake:codex"],
      ["outcome", "fake:claude"],
      ["delegation", "codex"],
    ]);
    // 0.1.3's statistics keep the hosts apart by key.
    expect(Object.keys(computeStats(readLog(join(home, "log.jsonl"))).byModel).sort()).toEqual([
      "codex/gpt-9.1-sol",
      "fake:claude/claude-opus-9-1",
      "fake:codex/gpt-9.1-sol",
    ]);
  });

  it("0.1.3 keeps another host's entries when it rewrites the files (that path is unchanged since 0.1.3)", () => {
    const home = tempDir();
    const subsPath = join(home, "subscriptions.yaml");
    writeSubscriptions(subsPath, {
      codex: { plan: "ChatGPT Pro", quota: "generous" },
      "fake:codex": { plan: "ChatGPT Plus", quota: "tight" },
    });
    // A 0.1.3 set_subscription reads every profile with its schema, changes one and writes them all.
    const parsed = SubscriptionsFileSchema.parse(parse(readFileSync(subsPath, "utf8")));
    writeSubscriptions(subsPath, { ...parsed.subscriptions, claudeAgent: { plan: "Claude Max", quota: "generous" } });
    expect(Object.keys(readSubscriptions(subsPath).subscriptions).sort()).toEqual([
      "claudeAgent",
      "codex",
      "fake:codex",
    ]);
    // A 0.1.3 mark_unavailable keeps every other mark in force.
    const marksPath = join(home, "unavailable.json");
    markUnavailable(marksPath, { providerInstanceId: "fake:codex", reason: "limit" }, T0);
    markUnavailable(marksPath, { providerInstanceId: "codex", reason: "plan" }, T0);
    expect(activeMarks(marksPath, T0).map((m) => m.providerInstanceId)).toEqual(["fake:codex", "codex"]);
  });
});

describe("files written by 0.1.3, read now", () => {
  it("read the same for T3, with another host registered too", async () => {
    const home = written013();
    const s = await connect(home);
    const got = await s.call("get_subscriptions");
    expect(got.subscriptions).toEqual(readSubscriptions(join(home, "subscriptions.yaml")).subscriptions);
    expect(Object.keys(got.subscriptions as object)).toEqual(["claudeAgent", "cursor", "grok", "opencode"]);
    expect(got).not.toHaveProperty("otherHosts");

    const inForce = (JSON.parse(s.read("unavailable.json")).marks as { until: string }[]).filter(
      (m) => Date.parse(m.until) > T0.getTime(),
    );
    expect(inForce).toHaveLength(3);
    const stats = await s.call("get_stats");
    expect(stats).toEqual({
      log: join(home, "log.jsonl"),
      ...computeStats(readLog(join(home, "log.jsonl"))),
      unavailable: inForce,
    });
    expect((stats.total as { delegations: number }).delegations).toBe(3);

    const fromDisk = await s.call("recommend_model", { task: "x", taskType: "code" });
    expect(fromDisk.capabilitiesFrom).toBe("disk-cache");
    expect(fromDisk.capabilitiesAgeMinutes).toBe(60);
    const given = await s.call("recommend_model", {
      task: "x",
      taskType: "code",
      capabilities: JSON.parse(readFileSync(new URL("capabilities-cache.json", FIXTURES), "utf8")).capabilities,
    });
    expect(fromDisk.candidates).toEqual(given.candidates);
    expect(fromDisk.skipped).toEqual(given.skipped);
    const cleared = await s.call("mark_unavailable", { providerInstanceId: "nobody", clear: true });
    expect(cleared).toEqual({ cleared: [], active: inForce });
  });

  it("another host sees 0.1.3's data as T3's, and none of it as its own", async () => {
    const s = await connect(written013());
    const theirs = await s.call("get_subscriptions", { host: "fake" });
    expect(theirs.subscriptions).toEqual({});
    expect(Object.keys(theirs.otherHosts as object)).toEqual(["t3:claudeAgent", "t3:cursor", "t3:grok", "t3:opencode"]);
    const none = await s.client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", host: "fake" },
    });
    expect(resultText(none)).toBe(fake.text.noCatalog);
    expect(await s.call("mark_unavailable", { host: "fake", providerInstanceId: "nobody", clear: true })).toEqual({
      cleared: [],
      active: [],
    });
    expect(((await s.call("get_stats", { host: "fake" })).total as { delegations: number }).delegations).toBe(0);
  });
});
