import { describe, expect, it } from "vitest";
import { parseCapabilities } from "../src/capabilities.js";
import { findEffortOption } from "../src/effort.js";
import { type Recommendation, recommendModel } from "../src/recommend.js";
import { NoneUsageSource } from "../src/usage.js";
import { defaultPolicy, driverFixture, driverFixtureRaw, policyWith } from "./helpers.js";

// Every fixture in test/fixtures/drivers is invented: model versions do not exist.
const policy = defaultPolicy();
const none = new NoneUsageSource();

async function rec(capabilities: unknown, taskType = "code", p = policy): Promise<Recommendation> {
  return recommendModel({ task: "x", taskType, capabilities }, p, none);
}
const ids = (r: Recommendation) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);

const DRIVERS = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "kiro",
  "pi",
  "fx",
  "muse",
  "acpRegistry",
];
const TASK_TYPES = Object.keys(policy.taskTypes);

describe("a user with a single provider of each driver T3 ships", () => {
  it.each(DRIVERS)("%s: every task type gets a candidate on that provider", async (driver) => {
    const caps = driverFixture(driver);
    const instance = caps.providers[0]!.providerInstanceId;
    for (const taskType of TASK_TYPES) {
      const r = await rec(caps, taskType);
      expect(r.candidates.length, `${driver}/${taskType}`).toBeGreaterThan(0);
      expect(r.candidates.every((c) => c.providerInstanceId === instance)).toBe(true);
    }
  });

  it.each([
    ["claudeAgent", "code", "claudeAgent/claude-opus-9-2", [{ id: "effort", value: "high" }]],
    ["codex", "code", "codex/gpt-9.1-sol", [{ id: "reasoningEffort", value: "high" }]],
    ["codex", "quick", "codex/gpt-9-luna", [{ id: "reasoningEffort", value: "low" }]],
    ["cursor", "code", "cursor/claude-opus-9-1", [{ id: "effort", value: "high" }]],
    ["cursor", "quick", "cursor/composer-4", []],
    // Cursor's GPT declares `reasoning`, not `effort`.
    ["cursor", "review", "cursor/gpt-9.1-sol", [{ id: "reasoning", value: "high" }]],
    ["grok", "code", "grok/grok-8-build", [{ id: "reasoningEffort", value: "high" }]],
    ["grok", "review", "grok/grok-8.1", [{ id: "reasoningEffort", value: "high" }]],
    ["grok", "quick", "grok/grok-8.1-fast", []],
    // OpenCode: provider/ prefixes, including openrouter/anthropic/ and dotted versions; effort via `variant`.
    ["opencode", "code", "opencode/openrouter/anthropic/claude-opus-9.1", [{ id: "variant", value: "high" }]],
    ["opencode", "research", "opencode/anthropic/claude-sonnet-9-1", [{ id: "variant", value: "medium" }]],
    ["opencode", "quick", "opencode/opencode/nova-3-free", []],
    // Antigravity: effort is in the id; the flagship is a named tier.
    ["antigravity", "code", "antigravity/gemini-7-carbon", []],
    ["antigravity", "quick", "antigravity/gemini-6.8-flash-high", []],
    // Kiro: dotted ids, effort via reasoningEffort.
    ["kiro", "code", "kiro/claude-opus-9.1", [{ id: "reasoningEffort", value: "high" }]],
    ["kiro", "review", "kiro/gpt-8.6-sol", [{ id: "reasoningEffort", value: "high" }]],
    // Pi: provider/ prefix, effort via `thinking`.
    ["pi", "code", "pi/anthropic/claude-opus-9-1", [{ id: "thinking", value: "high" }]],
    // Muse: Spark comes first by policy order, not because 3.1 > 2.0 (Wonder is its own family).
    ["muse", "code", "muse/muse-spark-3.1", [{ id: "reasoningEffort", value: "high" }]],
  ])("%s/%s -> %s", async (driver, taskType, expected, options) => {
    const r = await rec(driverFixture(driver), taskType);
    expect(ids(r)[0]).toBe(expected);
    expect(r.candidates[0]!.options).toEqual(options);
    expect(["taskType", "fallback"]).toContain(r.candidates[0]!.source);
  });

  it.each([
    ["fx", "fx/default"],
    ["acpRegistry", "acp-vibe/default"],
  ])("%s: no policy family, so the provider's default model with low confidence", async (driver, expected) => {
    const r = await rec(driverFixture(driver));
    expect(ids(r)[0]).toBe(expected);
    expect(r.candidates[0]!.source).toBe("generic");
    expect(r.candidates[0]!.reason).toMatch(/low confidence/);
  });

  it("muse: Spark and Wonder are separate families, so a newer Wonder does not hide Spark", async () => {
    expect(ids(await rec(driverFixture("muse")))).toEqual([
      "muse/muse-spark-3.1",
      "muse/muse-wonder-2.0",
      "muse/default",
    ]);
    const caps = driverFixture("muse");
    caps.providers[0]!.models.push({ id: "muse-wonder-9.0" });
    const r = await rec(caps);
    expect(ids(r)).toEqual(["muse/muse-spark-3.1", "muse/muse-wonder-9.0", "muse/default"]);
    expect(r.candidates[1]!.reason).toMatch(/latest muse-wonder on muse is muse-wonder-9\.0/);
  });

  it("fx: the generic candidate still gets effort through fx's `effort` option", async () => {
    const r = await rec(driverFixture("fx"), "debug");
    expect(r.candidates[0]!.options).toEqual([{ id: "effort", value: "xhigh" }]);
  });
});

describe("only providers t3-autopilot does not know", () => {
  it("recommends their first listed model with low confidence instead of nothing", async () => {
    const r = await rec(driverFixture("unknown-only"));
    expect(ids(r)).toEqual(["sparrow/sparrow-large"]);
    expect(r.candidates[0]).toMatchObject({ source: "generic", sameAsOrchestrator: true });
    expect(r.candidates[0]!.reason).toMatch(/low confidence/);
    expect(r.skipped).toContain('generic: heron lists no models and its driver "heronAgent" has no known default');
  });

  it("uses a known driver's default slug when that provider lists no models", async () => {
    const caps = driverFixture("unknown-only");
    caps.providers.push({
      providerInstanceId: "kiro-2",
      driverKind: "kiro",
      models: [],
      canRunChildTask: true,
      constraints: [],
    });
    const r = await rec(caps);
    expect(ids(r)).toContain("kiro-2/default");
  });
});

describe("several instances of the same driver", () => {
  it("considers every instance and resolves families per instance", async () => {
    const r = await rec(driverFixture("multi-instance"));
    expect(ids(r)).toEqual(["claudeAgent/claude-opus-9-2", "claudeAgent-work/claude-opus-9-2", "codex/gpt-9.1-sol"]);
  });

  it("resolves each instance's own model list", async () => {
    const r = await rec(driverFixture("multi-instance"), "review", policyWith({ excludeProviders: ["codex"] }));
    // codex-team does not list gpt-9.1-sol, so its newest gpt is gpt-9-astra.
    expect(ids(r)[0]).toBe("codex-team/gpt-9-astra");
  });

  it("an instance can be excluded by id while the other one stays", async () => {
    const r = await rec(driverFixture("multi-instance"), "code", policyWith({ excludeProviders: ["claudeAgent"] }));
    expect(ids(r)[0]).toBe("claudeAgent-work/claude-opus-9-2");
  });
});

describe("nothing usable", () => {
  it("fails clearly when every provider is disabled", async () => {
    await expect(rec(driverFixture("all-disabled"))).rejects.toThrow(
      /No provider instance can run a child task \(claudeAgent: Provider instance is disabled; cursor: Provider executable is not installed; grok: Provider is not authenticated\)\. Enable/,
    );
  });

  it("fails clearly when capabilities list no provider", async () => {
    await expect(rec({ providers: [] })).rejects.toThrow(/lists no provider/);
  });
});

describe("mixed providers and omitted models", () => {
  it("warns about short lists on large catalogs and suggests a search", async () => {
    const r = await rec(driverFixture("mixed"));
    const cursor = r.warnings.find((w) => w.startsWith("cursor:"));
    expect(cursor).toMatch(/left out 40 models/);
    expect(cursor).toMatch(/"cursor opus"/);
    expect(r.warnings.some((w) => w.startsWith("kiro:"))).toBe(false);
  });

  it("does not warn for drivers whose current models T3 always lists", async () => {
    const r = await rec(driverFixture("claudeAgent"));
    expect(driverFixture("claudeAgent").providers[0]!.omittedModels).toBe(4);
    expect(r.warnings).toEqual([]);
  });

  it("merges a search output so a model left out of the short list can win", async () => {
    const before = await rec(driverFixture("cursor"), "review");
    expect(ids(before)).toContain("cursor/gemini-7-pro");
    const merged = [driverFixtureRaw("cursor"), driverFixtureRaw("search-cursor-gemini")];
    const after = await rec(merged, "review");
    expect(ids(after)).toContain("cursor/gemini-8-pro");
    expect(ids(after)).not.toContain("cursor/gemini-7-pro");
    expect(after.warnings).toEqual([]);
  });
});

describe("capabilities as T3 sends them", () => {
  it("accepts null for absent thread fields and display names", () => {
    const caps = parseCapabilities({
      parentThreadId: null,
      inheritedProviderInstanceId: null,
      inheritedModel: null,
      providers: [
        {
          providerInstanceId: "x",
          driverKind: "codex",
          displayName: null,
          models: [],
          canRunChildTask: true,
          canRunCrossProviderChildTask: true,
          constraints: [],
        },
      ],
    });
    expect(caps.inheritedProviderInstanceId).toBeNull();
  });

  it("rejects numeric option values (T3 only sends strings and booleans)", () => {
    expect(() =>
      parseCapabilities({
        providers: [{ providerInstanceId: "x", models: [{ id: "m", options: [{ id: "effort", values: [1, 2] }] }] }],
      }),
    ).toThrow(/orchestrator_capabilities/);
  });
});

describe("effort option detection", () => {
  it("skips a boolean thinking toggle and uses the effort select", () => {
    const opt = findEffortOption(
      [
        { id: "thinking", values: [false, true] },
        { id: "effort", values: ["low", "high"] },
      ],
      ["thinking", "effort"],
    );
    expect(opt?.id).toBe("effort");
  });

  it("finds an ACP agent's own reasoning option by name", () => {
    expect(
      findEffortOption(
        [
          { id: "mode", values: ["default", "plan"] },
          { id: "thought_depth", values: ["low", "high"] },
        ],
        ["effort"],
      )?.id,
    ).toBe("thought_depth");
    expect(findEffortOption([{ id: "depth", values: ["shallow", "deep"] }], ["effort"])).toBeUndefined();
  });
});
