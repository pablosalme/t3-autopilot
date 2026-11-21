import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CapabilitiesEntry,
  loadLatestEntry,
  loadSessionEntry,
  SESSION_ENTRIES_MAX,
  saveSessionEntry,
} from "../src/capabilitiesCache.js";
import { t3 } from "../src/hosts/t3.js";
import type { Recommendation } from "../src/recommend.js";
import { fake, fakePayload } from "./fakeHost.js";
import { connectServer, driverFixtureRaw, fixture, resultText, tempDir } from "./helpers.js";

type Result = Recommendation & { capabilitiesFrom: string; capabilitiesAgeMinutes?: number; host?: string };

const T0 = new Date("2026-11-21T09:00:00Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

/** A server on `home` that knows T3 and the fake host, its clock at `at`; a new one is a restart. */
async function serverAt(home: string, at = T0) {
  const { client } = await connectServer(home, { hosts: [t3, fake], now: () => at });
  return async (args: Record<string, unknown>) =>
    client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
}
const data = (res: object) => {
  expect((res as { isError?: boolean }).isError, resultText(res)).toBeFalsy();
  return (res as { structuredContent: Result }).structuredContent;
};
const first = (r: Result) => `${r.candidates[0]?.providerInstanceId}/${r.candidates[0]?.model}`;
const json = (home: string, name: string) => JSON.parse(readFileSync(join(home, name), "utf8"));

/** Two orchestrators' catalogs: one on Codex only, one on Cursor only. */
const codexOnly = () => driverFixtureRaw("codex");
const cursorOnly = () => driverFixtureRaw("cursor");
const fakeCaps = () => fakePayload([{ id: "claude", driver: "claudeAgent", models: ["claude-opus-9-1"] }]);

describe("capabilities kept per host", () => {
  it("a T3 restart does not see the fake host's capabilities, nor the fake host T3's", async () => {
    const home = tempDir();
    data(await (await serverAt(home))({ host: "fake", capabilities: fakeCaps() }));
    expect(existsSync(join(home, "capabilities-cache.fake.json"))).toBe(true);
    expect(existsSync(join(home, "capabilities-cache.json"))).toBe(false);
    expect(existsSync(join(home, "capabilities-cache.t3.json"))).toBe(false);
    const t3After = await (await serverAt(home, hours(1)))({});
    expect(resultText(t3After)).toBe(t3.text.noCatalog);

    const other = tempDir();
    data(await (await serverAt(other))({ capabilities: codexOnly() }));
    const fakeAfter = await (await serverAt(other, hours(1)))({ host: "fake" });
    expect(resultText(fakeAfter)).toBe(fake.text.noCatalog);
  });

  it("another host with no session gets the entry it saved last after a restart", async () => {
    const home = tempDir();
    const call = await serverAt(home);
    data(await call({ host: "fake", capabilities: fakeCaps(), session: "t7" }));
    data(await call({ host: "fake", capabilities: fakePayload([{ id: "gem", models: ["gemini-9-pro"] }]) }));
    expect(Object.keys(json(home, "capabilities-cache.fake.json").entries)).toEqual(["", "t7"]);
    const after = data(await (await serverAt(home, hours(1)))({ host: "fake" }));
    expect(after.capabilitiesFrom).toBe("disk-cache");
    expect(first(after)).toBe("gem/gemini-9-pro");
    const t7 = data(await (await serverAt(home, hours(1)))({ host: "fake", session: "t7" }));
    expect(first(t7)).toBe("claude/claude-opus-9-1");
  });
});

describe("capabilities kept per session", () => {
  it("two T3 orchestrators each get their own back after a restart; without a session, the last one, as in 0.1", async () => {
    const home = tempDir();
    const call = await serverAt(home);
    const a = data(await call({ session: "orchestrator-a", capabilities: codexOnly() }));
    const b = data(await call({ session: "orchestrator-b", capabilities: cursorOnly() }));
    expect(first(a)).toMatch(/^codex\//);
    expect(first(b)).toMatch(/^cursor\//);
    // In memory, each session finds its own.
    const again = data(await call({ session: "orchestrator-a" }));
    expect(again.capabilitiesFrom).toBe("cache");
    expect(first(again)).toBe(first(a));

    const restarted = await serverAt(home, hours(2));
    const backA = data(await restarted({ session: "orchestrator-a" }));
    expect(backA.capabilitiesFrom).toBe("disk-cache");
    expect(backA.capabilitiesAgeMinutes).toBe(120);
    expect(first(backA)).toBe(first(a));
    expect(backA.warnings[0]).toMatch(/^Capabilities from the disk cache \(the server restarted\): received 2 h ago/);
    expect(first(data(await restarted({ session: "orchestrator-b" })))).toBe(first(b));
    // No session: capabilities-cache.json, the last one saved, as every 0.1 version does.
    const anyone = data(await (await serverAt(home, hours(2)))({}));
    expect(first(anyone)).toBe(first(b));
    expect(json(home, "capabilities-cache.json").capabilities.providers[0].providerInstanceId).toBe("cursor");
    // A session the server does not know never gets another's.
    expect(resultText(await (await serverAt(home, hours(2)))({ session: "orchestrator-c" }))).toBe(t3.text.noCatalog);
  });

  it("T3's parentThreadId is the session new capabilities are saved under", async () => {
    const home = tempDir();
    // fixture() is the output of thread:example-orchestrator; the call names no session.
    data(await (await serverAt(home))({ capabilities: fixture() }));
    expect(Object.keys(json(home, "capabilities-cache.t3.json").entries)).toEqual(["thread:example-orchestrator"]);
    const mine = data(await (await serverAt(home, hours(1)))({ session: "thread:example-orchestrator" }));
    expect(mine.capabilitiesFrom).toBe("disk-cache");
    expect(first(mine)).toBe("claudeAgent/claude-opus-7-1");
    // A session named in the call wins over the payload's.
    data(await (await serverAt(home))({ session: "mine", capabilities: fixture() }));
    expect(Object.keys(json(home, "capabilities-cache.t3.json").entries).sort()).toEqual([
      "mine",
      "thread:example-orchestrator",
    ]);
  });

  it("an output with no thread and no session is kept only in capabilities-cache.json", async () => {
    const home = tempDir();
    const providersOnly = (codexOnly() as { providers: unknown[] }).providers;
    data(await (await serverAt(home))({ capabilities: providersOnly }));
    expect(existsSync(join(home, "capabilities-cache.json"))).toBe(true);
    expect(existsSync(join(home, "capabilities-cache.t3.json"))).toBe(false);
  });

  it("merges a search into the session's own entry, also after a restart", async () => {
    const home = tempDir();
    data(await (await serverAt(home))({ session: "a", capabilities: driverFixtureRaw("mixed") }));
    data(await (await serverAt(home))({ session: "b", capabilities: codexOnly() }));
    const merged = data(
      await (await serverAt(home, hours(1)))({
        session: "a",
        capabilities: driverFixtureRaw("search-mixed-cursor-opus"),
        mergeCapabilities: true,
      }),
    );
    expect(merged.capabilitiesFrom).toBe("merged");
    expect(merged.candidates.map((c) => c.model)).toContain("claude-opus-9-2");
    const later = data(await (await serverAt(home, hours(2)))({ session: "a" }));
    expect(later.capabilitiesAgeMinutes).toBe(120);
    expect(later.candidates.map((c) => c.model)).toContain("claude-opus-9-2");
    expect(first(data(await (await serverAt(home, hours(2)))({ session: "b" })))).toMatch(/^codex\//);
  });

  it("an entry older than the TTL is not served and goes at the next save; TTL 0 keeps nothing on disk", async () => {
    const home = tempDir();
    data(await (await serverAt(home))({ session: "old", capabilities: codexOnly() }));
    expect(resultText(await (await serverAt(home, hours(12.5)))({ session: "old" }))).toBe(t3.text.noCatalog);
    data(await (await serverAt(home, hours(12.5)))({ session: "new", capabilities: cursorOnly() }));
    expect(Object.keys(json(home, "capabilities-cache.t3.json").entries)).toEqual(["new"]);

    const off = tempDir();
    writeFileSync(join(off, "policy.yaml"), "capabilitiesCacheTtlHours: 0\n");
    data(await (await serverAt(off))({ session: "a", capabilities: codexOnly() }));
    data(await (await serverAt(off))({ host: "fake", capabilities: fakeCaps() }));
    expect(existsSync(join(off, "capabilities-cache.json"))).toBe(false);
    expect(existsSync(join(off, "capabilities-cache.t3.json"))).toBe(false);
    expect(existsSync(join(off, "capabilities-cache.fake.json"))).toBe(false);
  });

  it(`keeps the ${SESSION_ENTRIES_MAX} sessions saved last, on disk and in memory`, async () => {
    const home = tempDir();
    const call = await serverAt(home);
    for (let i = 0; i <= SESSION_ENTRIES_MAX; i++) data(await call({ session: `s${i}`, capabilities: codexOnly() }));
    const saved = Object.keys(json(home, "capabilities-cache.t3.json").entries);
    expect(saved).toHaveLength(SESSION_ENTRIES_MAX);
    expect(saved[0]).toBe(`s${SESSION_ENTRIES_MAX}`);
    expect(saved).not.toContain("s0");
    // s0 left memory too, and the disk no longer has it.
    expect(resultText(await call({ session: "s0" }))).toBe(t3.text.noCatalog);
    expect(data(await call({ session: "s1" })).capabilitiesFrom).toBe("cache");
  });

  it("ignores a host cache file that is not valid, and an entry that is not, and writes a good one", async () => {
    const home = tempDir();
    writeFileSync(join(home, "capabilities-cache.t3.json"), "{not json");
    expect(resultText(await (await serverAt(home))({ session: "a" }))).toBe(t3.text.noCatalog);
    data(await (await serverAt(home))({ session: "a", capabilities: codexOnly() }));
    const file = json(home, "capabilities-cache.t3.json");
    expect(file.version).toBe(1);
    file.entries.broken = { receivedAt: T0.toISOString() };
    writeFileSync(join(home, "capabilities-cache.t3.json"), JSON.stringify(file));
    expect(first(data(await (await serverAt(home))({ session: "a" })))).toMatch(/^codex\//);
    expect(resultText(await (await serverAt(home))({ session: "broken" }))).toBe(t3.text.noCatalog);
  });
});

describe("the per-session file", () => {
  const entry = (receivedAt: Date, provider = "codex"): CapabilitiesEntry => ({
    capabilities: { providers: [{ providerInstanceId: provider, models: [], canRunChildTask: true }] },
    receivedAt: receivedAt.toISOString(),
    merged: false,
  });

  it("saves by session, newest first, and the newest wins a tie", () => {
    const path = join(tempDir(), "capabilities-cache.x.json");
    saveSessionEntry(path, "a", entry(T0, "a"), T0, 12);
    saveSessionEntry(path, "b", entry(T0, "b"), T0, 12);
    expect(loadLatestEntry(path, 12, T0)?.capabilities.providers[0]?.providerInstanceId).toBe("b");
    saveSessionEntry(path, "a", entry(T0, "a2"), T0, 12);
    expect(loadLatestEntry(path, 12, T0)?.capabilities.providers[0]?.providerInstanceId).toBe("a2");
    expect(loadSessionEntry(path, "b", 12, T0)?.capabilities.providers[0]?.providerInstanceId).toBe("b");
    expect(loadSessionEntry(path, "b", 0, T0)).toBeUndefined();
    expect(loadLatestEntry(path, 0, T0)).toBeUndefined();
    expect(loadSessionEntry(path, "c", 12, T0)).toBeUndefined();
  });

  it("keeps a session named __proto__ as a plain key", () => {
    const path = join(tempDir(), "capabilities-cache.x.json");
    saveSessionEntry(path, "__proto__", entry(T0), T0, 12);
    expect(loadSessionEntry(path, "__proto__", 12, T0)?.capabilities.providers).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).entries)).toEqual(["__proto__"]);
    expect(loadLatestEntry(join(tempDir(), "missing.json"), 12, T0)).toBeUndefined();
  });
});
