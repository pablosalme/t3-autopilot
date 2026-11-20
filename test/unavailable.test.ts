import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Recommendation, recommendModel } from "../src/recommend.js";
import {
  activeMarks,
  clearUnavailable,
  findMark,
  markUnavailable,
  readMarks,
  type UnavailableMark,
} from "../src/unavailable.js";
import { NoneUsageSource } from "../src/usage.js";
import { connectServer, defaultPolicy, driverFixture, resultText, tempDir } from "./helpers.js";

const T0 = new Date("2026-11-19T08:00:00Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const policy = defaultPolicy();
const ids = (r: Pick<Recommendation, "candidates">) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
const rec = (unavailable: UnavailableMark[], fixtureName = "mixed") =>
  recommendModel(
    { task: "x", taskType: "code", capabilities: driverFixture(fixtureName), unavailable },
    policy,
    new NoneUsageSource(),
  );
const mark = (providerInstanceId: string, model?: string, reason = "weekly limit reached"): UnavailableMark => ({
  providerInstanceId,
  ...(model === undefined ? {} : { model }),
  reason,
  markedAt: T0.toISOString(),
  until: hours(24).toISOString(),
});

describe("the marks file", () => {
  it("adds a mark for 24 h by default, replaces one for the same target and drops expired ones", () => {
    const path = join(tempDir(), "unavailable.json");
    const first = markUnavailable(path, { providerInstanceId: "cursor", model: "gemini-9-neon", reason: "plan" }, T0);
    expect(first).toEqual({
      providerInstanceId: "cursor",
      model: "gemini-9-neon",
      reason: "plan",
      markedAt: T0.toISOString(),
      until: hours(24).toISOString(),
    });
    markUnavailable(path, { providerInstanceId: "cursor", reason: "every model", until: hours(1).toISOString() }, T0);
    markUnavailable(path, { providerInstanceId: "cursor", model: "gemini-9-neon", reason: "again" }, hours(0.5));
    expect(readMarks(path).map((m) => m.reason)).toEqual(["every model", "again"]);
    // Two hours later the provider-wide mark has expired and is dropped on the next write.
    markUnavailable(path, { providerInstanceId: "codex", reason: "limit" }, hours(2));
    expect(readMarks(path).map((m) => `${m.providerInstanceId}/${m.model ?? "*"}`)).toEqual([
      "cursor/gemini-9-neon",
      "codex/*",
    ]);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("rejects an invalid or past until, and cuts a long reason", () => {
    const path = join(tempDir(), "unavailable.json");
    expect(() => markUnavailable(path, { providerInstanceId: "a", reason: "r", until: "soon" }, T0)).toThrow(
      /Invalid date in until: "soon"/,
    );
    expect(() =>
      markUnavailable(path, { providerInstanceId: "a", reason: "r", until: hours(-1).toISOString() }, T0),
    ).toThrow(/not in the future\. To remove a mark, pass clear: true/);
    expect(markUnavailable(path, { providerInstanceId: "a", reason: "x".repeat(500) }, T0).reason).toHaveLength(200);
  });

  it("clears a provider's marks, or one model's", () => {
    const path = join(tempDir(), "unavailable.json");
    markUnavailable(path, { providerInstanceId: "cursor", reason: "r" }, T0);
    markUnavailable(path, { providerInstanceId: "cursor", model: "m1", reason: "r" }, T0);
    markUnavailable(path, { providerInstanceId: "codex", reason: "r" }, T0);
    expect(clearUnavailable(path, { providerInstanceId: "cursor", model: "m1" }, T0)).toHaveLength(1);
    expect(activeMarks(path, T0)).toHaveLength(2);
    expect(clearUnavailable(path, { providerInstanceId: "cursor" }, T0)).toHaveLength(1);
    expect(activeMarks(path, T0).map((m) => m.providerInstanceId)).toEqual(["codex"]);
  });

  it("treats a missing or malformed file as no marks", () => {
    const dir = tempDir();
    expect(readMarks(join(dir, "none.json"))).toEqual([]);
    writeFileSync(join(dir, "bad.json"), '{"version":1,"marks":[{"providerInstanceId":1}]}');
    expect(readMarks(join(dir, "bad.json"))).toEqual([]);
  });

  it("finds a model's own mark before its provider's", () => {
    const marks = [mark("cursor", undefined, "all"), mark("cursor", "m1", "one")];
    expect(findMark(marks, "cursor", "m1")?.reason).toBe("one");
    expect(findMark(marks, "cursor", "m2")?.reason).toBe("all");
    expect(findMark(marks, "codex", "m1")).toBeUndefined();
  });

  it("a model ending in * covers every id that starts with it; the model's own mark and the longest prefix win", () => {
    const marks = [
      mark("opencode", undefined, "all"),
      mark("opencode", "opencode-go/*", "go plan"),
      mark("opencode", "opencode-go/kimi*", "kimi"),
      mark("opencode", "opencode-go/glm-8", "glm"),
    ];
    expect(findMark(marks, "opencode", "opencode-go/glm-8")?.reason).toBe("glm");
    expect(findMark(marks, "opencode", "opencode-go/kimi-k5")?.reason).toBe("kimi");
    expect(findMark(marks, "opencode", "opencode-go/minimax-m3")?.reason).toBe("go plan");
    expect(findMark(marks, "opencode", "openai/gpt-9.1-sol")?.reason).toBe("all");
    expect(findMark([mark("opencode", "opencode-go/*")], "opencode", "opencode/big-pickle")).toBeUndefined();
    expect(findMark([mark("opencode", "opencode-go/*")], "opencode", "opencode-go/*")?.model).toBe("opencode-go/*");
  });
});

describe("recommend_model with unavailable marks", () => {
  it("moves a marked provider after the available candidates and reports it when cut", async () => {
    expect(ids(await rec([]))).toEqual([
      "codex/gpt-9.1-sol",
      "cursor/claude-opus-9-1",
      "opencode/openrouter/anthropic/claude-opus-9.1",
    ]);
    const r = await rec([mark("codex")]);
    expect(ids(r)[0]).toBe("cursor/claude-opus-9-1");
    expect(ids(r).some((id) => id.startsWith("codex/"))).toBe(false);
    expect(r.skipped).toContain(
      `codex (every model): marked unavailable until ${hours(24).toISOString()} (weekly limit reached)`,
    );
  });

  it("marks one model only, and gives the reason when the candidate is still listed", async () => {
    const r = await rec([mark("cursor", "claude-opus-9-1", "Claude Opus 9.1 is not included in your plan")]);
    expect(ids(r)).not.toContain("cursor/claude-opus-9-1");
    expect(ids(r)[0]).toBe("codex/gpt-9.1-sol");
    // A single provider: the marked candidates are all there is, so they stay, first, and say their quota may be out.
    const only = await rec([mark("codex")], "codex");
    expect(only.candidates.length).toBeGreaterThan(0);
    for (const c of only.candidates) {
      expect(c.reason).toContain(
        `marked unavailable until ${hours(24).toISOString()}: weekly limit reached; quota may be exhausted; ` +
          "no available candidate ranks higher",
      );
      expect(c.reason).not.toMatch(/moved to the end|ranked after available/);
    }
    const one = await rec([mark("codex", "gpt-9.1-sol")], "codex");
    expect(ids(one)[0]).not.toBe("codex/gpt-9.1-sol");
    expect(ids(one)).toContain("codex/gpt-9.1-sol");
    expect(one.candidates.at(-1)!.reason).toMatch(
      /marked unavailable until .*: weekly limit reached; ranked after available candidates/,
    );
  });

  it("says where a marked candidate stands: after available ones, or first with its quota maybe exhausted", async () => {
    const until = hours(24).toISOString();
    const providers = (driverFixture("mixed") as { providers: { providerInstanceId: string }[] }).providers.map(
      (p) => p.providerInstanceId,
    );
    // Every provider but Codex marked: Codex comes first and the marked ones say they rank after it.
    const after = await rec(providers.filter((id) => id !== "codex").map((id) => mark(id)));
    expect(ids(after)[0]).toBe("codex/gpt-9.1-sol");
    const later = after.candidates.filter((c) => c.providerInstanceId !== "codex");
    expect(later.length).toBeGreaterThan(0);
    for (const c of later) {
      expect(c.reason).toContain(
        `marked unavailable until ${until}: weekly limit reached; ranked after available candidates`,
      );
    }
    // Every provider marked: the first one heads the list, and no reason claims it went to the end.
    const all = await rec(providers.map((id) => mark(id)));
    expect(ids(all)[0]).toBe("codex/gpt-9.1-sol");
    for (const c of all.candidates) {
      expect(c.reason).toContain(
        `marked unavailable until ${until}: weekly limit reached; quota may be exhausted; no available candidate ranks higher`,
      );
      expect(c.reason).not.toMatch(/moved to the end|ranked after available/);
    }
  });
});

describe("mark_unavailable through the server", () => {
  const caps = () => driverFixture("mixed");

  it("demotes until it expires, survives a restart, shows in get_stats and can be cleared", async () => {
    const home = tempDir();
    let at = T0;
    const { client } = await connectServer(home, { now: () => at });
    const recommend = async () => {
      const res = await client.callTool({
        name: "recommend_model",
        arguments: { task: "x", taskType: "code", capabilities: caps() },
      });
      expect(res.isError, resultText(res)).toBeFalsy();
      return res.structuredContent as Recommendation;
    };
    expect(ids(await recommend())[0]).toBe("codex/gpt-9.1-sol");

    const marked = await client.callTool({
      name: "mark_unavailable",
      arguments: { providerInstanceId: "codex", reason: "usage limit", until: hours(5).toISOString() },
    });
    expect(marked.isError, resultText(marked)).toBeFalsy();
    expect((marked.structuredContent as { marked: UnavailableMark }).marked.until).toBe(hours(5).toISOString());
    expect(ids(await recommend())[0]).toBe("cursor/claude-opus-9-1");

    const stats = await client.callTool({ name: "get_stats", arguments: {} });
    expect((stats.structuredContent as { unavailable: UnavailableMark[] }).unavailable).toMatchObject([
      { providerInstanceId: "codex", reason: "usage limit" },
    ]);
    const byType = await client.callTool({ name: "get_stats", arguments: { taskType: "code" } });
    expect((byType.structuredContent as { unavailable: unknown[] }).unavailable).toHaveLength(1);

    // A restarted server reads the same file.
    const again = await connectServer(home, { now: () => at });
    const res = await again.client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: caps() },
    });
    expect(ids(res.structuredContent as Recommendation)[0]).toBe("cursor/claude-opus-9-1");

    // Expired: back in first place.
    at = hours(6);
    expect(ids(await recommend())[0]).toBe("codex/gpt-9.1-sol");

    at = T0;
    const cleared = await client.callTool({
      name: "mark_unavailable",
      arguments: { providerInstanceId: "codex", clear: true },
    });
    expect((cleared.structuredContent as { cleared: unknown[]; active: unknown[] }).cleared).toHaveLength(1);
    expect(ids(await recommend())[0]).toBe("codex/gpt-9.1-sol");
  });

  it("needs a reason, and a failure outcome does not demote anything", async () => {
    const { client } = await connectServer();
    const noReason = await client.callTool({ name: "mark_unavailable", arguments: { providerInstanceId: "codex" } });
    expect(noReason.isError).toBe(true);
    expect(resultText(noReason)).toMatch(/needs a reason/);
    const past = await client.callTool({
      name: "mark_unavailable",
      arguments: { providerInstanceId: "codex", reason: "r", until: "2000-01-01" },
    });
    expect(past.isError).toBe(true);

    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: "log_outcome",
        arguments: { taskType: "code", providerInstanceId: "codex", model: "gpt-9.1-sol", outcome: "failure" },
      });
    }
    const res = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: caps() },
    });
    expect(ids(res.structuredContent as Recommendation)[0]).toBe("codex/gpt-9.1-sol");
  });
});
