import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAge, loadCapabilitiesCache } from "../src/capabilitiesCache.js";
import type { Recommendation } from "../src/recommend.js";
import { writeJsonAtomic } from "../src/store.js";
import { connectServer, driverFixtureRaw, fixture, resultText, tempDir } from "./helpers.js";

type Result = Recommendation & { capabilitiesFrom: string; capabilitiesAgeMinutes?: number };

const T0 = new Date("2026-11-19T08:00:00Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

/** A server on `home` whose clock reads `at`; each call starts a new one, as a restart would. */
async function serverAt(home: string, at: Date) {
  const { client } = await connectServer(home, { now: () => at });
  return async (args: Record<string, unknown>) =>
    client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
}
const okData = (res: object) => {
  expect((res as { isError?: boolean }).isError, resultText(res)).toBeFalsy();
  return (res as { structuredContent: Result }).structuredContent;
};
const ids = (r: Result) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
const cacheFile = (home: string) => join(home, "capabilities-cache.json");
const saved = (home: string) => JSON.parse(readFileSync(cacheFile(home), "utf8"));

describe("capabilities saved on disk across a server restart", () => {
  it("a restarted server reuses the last full output and says it came from the disk cache", async () => {
    const home = tempDir();
    const first = okData(await (await serverAt(home, T0))({ capabilities: fixture() }));
    expect(first.capabilitiesFrom).toBe("call");
    expect(first.capabilitiesAgeMinutes).toBeUndefined();
    expect(saved(home)).toMatchObject({ version: 1, receivedAt: T0.toISOString(), merged: false });

    const call = await serverAt(home, hours(3.1));
    const after = okData(await call({}));
    expect(after.capabilitiesFrom).toBe("disk-cache");
    expect(after.capabilitiesAgeMinutes).toBe(186);
    expect(ids(after)).toEqual(ids(first));
    expect(after.warnings[0]).toMatch(
      /^Capabilities from the disk cache \(the server restarted\): received 3 h 6 min ago by an orchestrator on claudeAgent \/ claude-opus-7-1\. /,
    );
    // Still from disk on the next call of the same server, until fresh capabilities arrive.
    expect(okData(await call({})).capabilitiesFrom).toBe("disk-cache");
    const fresh = okData(await call({ capabilities: fixture() }));
    expect(fresh.capabilitiesFrom).toBe("call");
    expect(fresh.warnings.some((w) => w.startsWith("Capabilities from the disk cache"))).toBe(false);
    expect(okData(await call({})).capabilitiesFrom).toBe("cache");
    expect(saved(home).receivedAt).toBe(hours(3.1).toISOString());
  });

  it("an expired or missing copy gives the usual error", async () => {
    const home = tempDir();
    okData(await (await serverAt(home, T0))({ capabilities: fixture() }));
    const res = await (await serverAt(home, hours(12.1)))({});
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(resultText(res)).toMatch(/^No capabilities yet: call orchestrator_capabilities/);
    expect(okData(await (await serverAt(home, hours(11.9)))({})).capabilitiesFrom).toBe("disk-cache");
    const empty = await (await serverAt(tempDir(), T0))({});
    expect(resultText(empty)).toMatch(/^No capabilities yet/);
  });

  it("the TTL comes from the policy, and 0 turns the disk cache off", async () => {
    const home = tempDir();
    writeFileSync(join(home, "policy.yaml"), "capabilitiesCacheTtlHours: 1\n");
    okData(await (await serverAt(home, T0))({ capabilities: fixture() }));
    expect(resultText(await (await serverAt(home, hours(1.5)))({}))).toMatch(/^No capabilities yet/);

    const off = tempDir();
    writeFileSync(join(off, "policy.yaml"), "capabilitiesCacheTtlHours: 0\n");
    okData(await (await serverAt(off, T0))({ capabilities: fixture() }));
    expect(existsSync(cacheFile(off))).toBe(false);
  });

  it("does not keep a lone search output as the catalog", async () => {
    const home = tempDir();
    const call = await serverAt(home, T0);
    const search = okData(
      await call({ capabilities: driverFixtureRaw("search-mixed-cursor-opus"), mergeCapabilities: true }),
    );
    expect(search.capabilitiesFrom).toBe("call");
    expect(search.warnings[0]).toMatch(/only this output was used and it was not kept/);
    expect(existsSync(cacheFile(home))).toBe(false);
    expect(resultText(await call({}))).toMatch(/^No capabilities yet/);
  });

  it("merges a search into the saved copy after a restart, keeping the full output's age", async () => {
    const home = tempDir();
    okData(await (await serverAt(home, T0))({ capabilities: driverFixtureRaw("mixed") }));
    const call = await serverAt(home, hours(2));
    const merged = okData(
      await call({ capabilities: driverFixtureRaw("search-mixed-cursor-opus"), mergeCapabilities: true }),
    );
    expect(merged.capabilitiesFrom).toBe("merged");
    expect(merged.capabilitiesAgeMinutes).toBe(120);
    expect(merged.warnings[0]).toMatch(/^Capabilities from the disk cache/);
    expect(ids(merged)).toContain("cursor/claude-opus-9-2");
    // Saved as a merge, still dated by the full output, so merges never extend its life.
    expect(saved(home)).toMatchObject({ receivedAt: T0.toISOString(), merged: true });
    const later = okData(await (await serverAt(home, hours(4)))({}));
    expect(later.capabilitiesFrom).toBe("disk-cache");
    expect(ids(later)).toContain("cursor/claude-opus-9-2");
    expect(resultText(await (await serverAt(home, hours(12.5)))({}))).toMatch(/^No capabilities yet/);
  });

  it("merges another orchestrator's search as its own, and still says who saved the copy", async () => {
    const home = tempDir();
    // Saved by an orchestrator on codex / gpt-9-astra.
    okData(await (await serverAt(home, T0))({ capabilities: driverFixtureRaw("mixed") }));
    const call = await serverAt(home, hours(1));
    const mine = {
      ...driverFixtureRaw("search-mixed-cursor-opus"),
      inheritedProviderInstanceId: "cursor",
      inheritedModel: "claude-opus-9-2",
    };
    const merged = okData(await call({ capabilities: mine, mergeCapabilities: true }));
    expect(merged.warnings[0]).toMatch(
      /received 1 h ago by an orchestrator on codex \/ gpt-9-astra\. If that is not you/,
    );
    // The caller's own provider and model decide sameAsOrchestrator, not the saved copy's.
    expect(merged.candidates.map((c) => [`${c.providerInstanceId}/${c.model}`, c.sameAsOrchestrator])).toEqual([
      ["codex/gpt-9.1-sol", false],
      ["cursor/claude-opus-9-2", true],
      ["opencode/openrouter/anthropic/claude-opus-9.1", false],
    ]);
    const next = okData(await call({}));
    expect(next.capabilitiesFrom).toBe("disk-cache");
    expect(next.warnings[0]).toMatch(/by an orchestrator on codex \/ gpt-9-astra\./);
    expect(next.candidates[1]).toMatchObject({ model: "claude-opus-9-2", sameAsOrchestrator: true });
    expect(saved(home).capabilities).toMatchObject({
      inheritedProviderInstanceId: "cursor",
      inheritedModel: "claude-opus-9-2",
    });
    expect(Object.keys(saved(home)).sort()).toEqual(["capabilities", "merged", "receivedAt", "version"]);
  });

  it("saves a list of outputs as a merge", async () => {
    const home = tempDir();
    const caps = [driverFixtureRaw("mixed"), driverFixtureRaw("search-mixed-cursor-opus")];
    expect(okData(await (await serverAt(home, T0))({ capabilities: caps })).capabilitiesFrom).toBe("call");
    expect(saved(home)).toMatchObject({ merged: true });
    // Passed for merging with nothing to merge into, a list is still a catalog to keep.
    const other = tempDir();
    const call = await serverAt(other, T0);
    expect(okData(await call({ capabilities: caps, mergeCapabilities: true })).warnings).not.toContainEqual(
      expect.stringMatching(/^mergeCapabilities/),
    );
    expect(okData(await call({})).capabilitiesFrom).toBe("cache");
    // Also as JSON strings, which parseCapabilities accepts in a list.
    const strings = await serverAt(tempDir(), T0);
    const asText = caps.map((c) => JSON.stringify(c));
    expect(okData(await strings({ capabilities: asText, mergeCapabilities: true })).warnings).not.toContainEqual(
      expect.stringMatching(/^mergeCapabilities/),
    );
    expect(okData(await strings({})).capabilitiesFrom).toBe("cache");
    // And the whole list as one JSON string.
    const whole = tempDir();
    const one = await serverAt(whole, T0);
    const res = okData(await one({ capabilities: JSON.stringify(caps), mergeCapabilities: true }));
    expect(res.warnings).not.toContainEqual(expect.stringMatching(/^mergeCapabilities/));
    expect(okData(await one({})).capabilitiesFrom).toBe("cache");
    expect(saved(whole)).toMatchObject({ merged: true });
  });

  it("writes atomically, ignores a corrupt copy and reports a failed save without failing", async () => {
    const home = tempDir();
    okData(await (await serverAt(home, T0))({ capabilities: fixture() }));
    expect(readdirSync(home)).toEqual(["capabilities-cache.json"]);

    writeFileSync(cacheFile(home), "{not json");
    expect(resultText(await (await serverAt(home, T0))({}))).toMatch(/^No capabilities yet/);
    writeFileSync(
      cacheFile(home),
      JSON.stringify({ version: 1, receivedAt: "yesterday", merged: false, capabilities: fixture() }),
    );
    expect(loadCapabilitiesCache(cacheFile(home), 12, T0)).toBeUndefined();

    // The data directory is a file, so nothing can be saved in it.
    const notADir = join(tempDir(), "file");
    writeFileSync(notADir, "");
    const res = okData(await (await serverAt(notADir, T0))({ capabilities: fixture() }));
    expect(res.warnings).toContainEqual(expect.stringMatching(/^Could not save the capabilities cache: /));
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it("removes the temporary file when the rename fails", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "taken.json"));
    writeFileSync(join(dir, "taken.json", "inside"), "");
    expect(() => writeJsonAtomic(join(dir, "taken.json"), { a: 1 })).toThrow();
    expect(readdirSync(dir)).toEqual(["taken.json"]);
  });

  it("formats ages for the warning", () => {
    expect(formatAge(-5)).toBe("0 min");
    expect(formatAge(59 * 60_000)).toBe("59 min");
    expect(formatAge(2 * 3_600_000)).toBe("2 h");
    expect(formatAge(2 * 3_600_000 + 5 * 60_000)).toBe("2 h 5 min");
  });
});
