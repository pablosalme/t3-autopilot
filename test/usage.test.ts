import { describe, expect, it } from "vitest";
import { type Recommendation, recommendModel } from "../src/recommend.js";
import { evaluateUsage, NoneUsageSource, type ProviderUsage } from "../src/usage.js";
import { connectServer, defaultPolicy, fixture, policyWith } from "./helpers.js";

const policy = defaultPolicy();

describe("evaluateUsage (#11)", () => {
  it("ignores windows with an unknown kind or a percentage outside 0-100", () => {
    const v = evaluateUsage(
      {
        providerInstanceId: "a",
        windows: [
          { kind: "daily", usedPercent: 99 },
          { kind: "weekly", usedPercent: 140 },
          { kind: "session", usedPercent: -3 },
          { kind: "weekly", usedPercent: Number.NaN },
        ],
      },
      "m",
      policy,
    );
    expect(v).toEqual({ tier: 0 });
  });

  it("still applies the valid windows next to invalid ones", () => {
    const v = evaluateUsage(
      {
        providerInstanceId: "a",
        windows: [
          { kind: "daily", usedPercent: 99 },
          { kind: "weekly", usedPercent: 100 },
        ],
      },
      "m",
      policy,
    );
    expect(v.tier).toBe(2);
  });
});

describe("usage passed in the call, across several providers", () => {
  // One candidate per provider, so each provider's place is easy to follow.
  const onePerProvider = policyWith({
    maxCandidates: 3,
    fallback: [],
    genericFallback: false,
    taskTypes: {
      code: {
        candidates: [
          { provider: "claudeAgent", family: "claude-opus", effort: "high" },
          { provider: "codex", family: "gpt", effort: "high" },
          { provider: "cursor", family: "gemini", effort: "high" },
          { provider: "grok", family: "grok", effort: "high" },
          { provider: "opencode", family: "claude-opus", effort: "high" },
        ],
      },
    },
  });
  const ALL = ["claudeAgent", "codex", "cursor", "grok", "opencode"];
  const at = (providerInstanceId: string, kind: string, usedPercent: number): ProviderUsage => ({
    providerInstanceId,
    windows: [{ kind, usedPercent }],
  });
  const rec = (usage: ProviderUsage[], p = onePerProvider) =>
    recommendModel({ task: "x", taskType: "code", capabilities: fixture(), usage }, p, new NoneUsageSource());
  const ids = (r: Recommendation) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);

  it("moves every provider above its threshold after the ones below, keeping policy order within each group", async () => {
    const r = await rec([at("claudeAgent", "weekly", 82), at("codex", "session", 85), at("cursor", "monthly", 89)]);
    expect(ids(r)).toEqual(["cursor/gemini-5.1-pro", "grok/grok-6", "opencode/opencode/claude-opus-7-1"]);
    expect(r.usageSource).toBe("none+call");
  });

  it("fills the free slots with busy providers, in policy order, before exhausted ones", async () => {
    const r = await rec([
      at("claudeAgent", "session", 100),
      at("codex", "weekly", 90),
      at("grok", "weekly", 100),
      at("opencode", "monthly", 95),
    ]);
    expect(ids(r)).toEqual(["cursor/gemini-5.1-pro", "codex/gpt-6.2-codex", "opencode/opencode/claude-opus-7-1"]);
    expect(r.candidates[1]!.reason).toMatch(/weekly usage 90% >= 75%; demoted for usage/);
    expect(r.candidates[2]!.reason).toMatch(/monthly usage 95% >= 90%; demoted for usage/);
  });

  it("uses each provider's worst window", async () => {
    const claude: ProviderUsage = {
      providerInstanceId: "claudeAgent",
      windows: [
        { kind: "session", usedPercent: 10 },
        { kind: "weekly", usedPercent: 100, resetsAt: "2026-11-20T08:00:00Z" },
      ],
    };
    expect(ids(await rec([claude]))).toEqual(["codex/gpt-6.2-codex", "cursor/gemini-5.1-pro", "grok/grok-6"]);
    const onlyClaude = policyWith({
      fallback: [],
      genericFallback: false,
      taskTypes: { code: { candidates: [{ provider: "claudeAgent", family: "claude-opus" }] } },
    });
    const r = await rec([claude], onlyClaude);
    expect(r.candidates[0]!.reason).toMatch(/weekly usage exhausted \(100%, resets 2026-11-20T08:00:00Z\)/);
  });

  it("adds up the windows of a provider passed in several entries, one per window", async () => {
    // The busy window comes first: the entry after it must not replace it.
    const r = await rec([at("claudeAgent", "weekly", 100), at("claudeAgent", "session", 10)]);
    expect(ids(r)).toEqual(["codex/gpt-6.2-codex", "cursor/gemini-5.1-pro", "grok/grok-6"]);
    const same = await rec([at("claudeAgent", "session", 10), at("claudeAgent", "weekly", 100)]);
    expect(ids(same)).toEqual(ids(r));
  });

  it("still recommends when every provider is exhausted, in policy order, each marked as exhausted", async () => {
    const r = await rec(ALL.map((id) => at(id, "session", 100)));
    expect(ids(r)).toEqual(["claudeAgent/claude-opus-7-1", "codex/gpt-6.2-codex", "cursor/gemini-5.1-pro"]);
    for (const c of r.candidates) expect(c.reason).toMatch(/session usage exhausted \(100%\); demoted for usage/);
  });

  it("with the default policy, all exhausted keeps the same ranking as no usage at all", async () => {
    const policy = defaultPolicy();
    const none = await recommendModel(
      { task: "x", taskType: "code", capabilities: fixture() },
      policy,
      new NoneUsageSource(),
    );
    const exhausted = await recommendModel(
      { task: "x", taskType: "code", capabilities: fixture(), usage: ALL.map((id) => at(id, "weekly", 100)) },
      policy,
      new NoneUsageSource(),
    );
    expect(ids(exhausted)).toEqual(ids(none));
    expect(exhausted.candidates.every((c) => /exhausted/.test(c.reason))).toBe(true);
  });

  it("noDemote keeps a busy provider first, but not an exhausted one", async () => {
    const p = policyWith({
      fallback: [],
      genericFallback: false,
      taskTypes: {
        code: {
          candidates: [
            { provider: "claudeAgent", family: "claude-opus", noDemote: true },
            { provider: "codex", family: "gpt", noDemote: true },
            { provider: "cursor", family: "gemini" },
          ],
        },
      },
    });
    const r = await rec([at("claudeAgent", "weekly", 99), at("codex", "weekly", 100), at("cursor", "weekly", 99)], p);
    expect(ids(r)).toEqual(["claudeAgent/claude-opus-7-1", "cursor/gemini-5.1-pro", "codex/gpt-6.2-codex"]);
    expect(r.candidates[0]!.reason).toMatch(/noDemote: kept in place despite usage/);
  });

  it("works the same through the MCP tool", async () => {
    const { client } = await connectServer();
    const res = await client.callTool({
      name: "recommend_model",
      arguments: {
        task: "x",
        taskType: "code",
        capabilities: fixture(),
        usage: [at("claudeAgent", "weekly", 82), at("codex", "session", 100), at("cursor", "weekly", 80)],
      },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as Recommendation;
    // Default policy: claudeAgent and cursor are busy, codex is exhausted; opencode and grok are not limited.
    expect(ids(data)[0]).toBe("opencode/opencode/claude-opus-7-1");
    expect(data.candidates.some((c) => c.providerInstanceId === "codex")).toBe(false);
    expect(data.usageSource).toBe("none+call");
  });
});
