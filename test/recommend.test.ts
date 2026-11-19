import { describe, expect, it } from "vitest";
import type { Policy } from "../src/policy.js";
import { type RecommendInput, recommendModel } from "../src/recommend.js";
import { NoneUsageSource, StaticUsageSource, type UsageSource } from "../src/usage.js";
import { defaultPolicy, fixture, policyWith } from "./helpers.js";

const policy = defaultPolicy();
const none = new NoneUsageSource();

function rec(input: Partial<RecommendInput>, p: Policy = policy, source: UsageSource = none) {
  return recommendModel({ task: "Implement the export endpoint", capabilities: fixture(), ...input }, p, source);
}
const ids = (r: Awaited<ReturnType<typeof rec>>) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);

describe("recommendModel", () => {
  it("returns up to three candidates ready for delegate_task.target", async () => {
    const r = await rec({});
    expect(r.taskType).toBe("code");
    expect(r.classification.source).toBe("classifier");
    expect(ids(r)).toEqual(["claudeAgent/claude-opus-7-1", "codex/gpt-6.2-codex", "cursor/claude-opus-7"]);
    expect(r.candidates[0]!.options).toEqual([{ id: "effort", value: "high" }]);
    expect(r.candidates[1]!.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(r.candidates[0]!.reason).toMatch(/claude-opus/);
  });

  it("uses the given taskType and rejects unknown ones", async () => {
    const r = await rec({ task: "anything", taskType: "research" });
    expect(r.classification.source).toBe("given");
    expect(ids(r)[0]).toBe("claudeAgent/claude-sonnet-7-1");
    await expect(rec({ taskType: "nope" })).rejects.toThrow(/Unknown taskType "nope"/);
  });

  it("accepts capabilities as a JSON string", async () => {
    const r = await rec({ capabilities: JSON.stringify(fixture()) });
    expect(ids(r)[0]).toBe("claudeAgent/claude-opus-7-1");
  });

  it("rejects input that is not orchestrator_capabilities output", async () => {
    await expect(rec({ capabilities: { foo: 1 } })).rejects.toThrow(/orchestrator_capabilities/);
    await expect(rec({ capabilities: "not json" })).rejects.toThrow(/not valid JSON/);
  });

  describe("provider eligibility", () => {
    it("excludes providers that cannot run child tasks", async () => {
      const caps = fixture();
      caps.providers.find((p) => p.providerInstanceId === "codex")!.canRunChildTask = false;
      caps.providers.find((p) => p.providerInstanceId === "codex")!.constraints = ["Provider instance is disabled."];
      const r = await rec({ capabilities: caps });
      expect(ids(r).some((id) => id.startsWith("codex/"))).toBe(false);
      expect(ids(r)).toEqual([
        "claudeAgent/claude-opus-7-1",
        "cursor/claude-opus-7",
        "opencode/opencode/claude-opus-7-1",
      ]);
      expect(r.skipped).toContain("codex: Provider instance is disabled.");
      expect(r.skipped).toContain("antigravity: Provider instance is disabled.");
    });

    it("excludes providers listed in excludeProviders", async () => {
      const r = await rec({}, policyWith({ excludeProviders: ["claudeAgent"] }));
      expect(ids(r)[0]).toBe("codex/gpt-6.2-codex");
      expect(r.skipped).toContain("claudeAgent: listed in excludeProviders");
    });

    it("expands a driver kind to every instance of it (several subscriptions)", async () => {
      const caps = fixture();
      const second = structuredClone(caps.providers.find((p) => p.providerInstanceId === "claudeAgent")!);
      second.providerInstanceId = "claudeAgent-work";
      caps.providers.push(second);
      const r = await rec({ capabilities: caps }, policyWith({ maxCandidates: 2 }));
      expect(ids(r)).toEqual(["claudeAgent/claude-opus-7-1", "claudeAgent-work/claude-opus-7-1"]);
    });
  });

  describe("effort", () => {
    it("shifts effort with size and criticality and clamps it to supported values", async () => {
      const r = await rec({ task: "Fix the crash", size: "large", criticality: "high" });
      expect(r.taskType).toBe("debug");
      // debug starts at xhigh; +2 -> max. Claude supports max; Codex tops out at xhigh.
      expect(r.candidates[0]!.options).toEqual([{ id: "effort", value: "max" }]);
      expect(r.candidates[1]!.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
      expect(r.candidates[1]!.reason).toMatch(/effort max not supported, using xhigh/);
    });

    it("lowers effort for small, low-criticality work but not below low", async () => {
      const r = await rec({ task: "Rename the module", taskType: "quick", size: "small", criticality: "low" });
      expect(r.candidates[0]).toMatchObject({ providerInstanceId: "claudeAgent", model: "claude-haiku-7-0" });
      expect(r.candidates[0]!.options).toEqual([{ id: "effort", value: "low" }]);
    });

    it("omits effort when the model has no effort option", async () => {
      const r = await rec({ task: "x", taskType: "quick" });
      const composer = r.candidates.find((c) => c.model === "composer-3")!;
      expect(composer.options).toEqual([]);
    });
  });

  describe("usage balancing", () => {
    it("treats unknown usage as no penalty", async () => {
      const r = await rec({});
      expect(r.usageSource).toBe("none");
      expect(ids(r)[0]).toBe("claudeAgent/claude-opus-7-1");
    });

    it("demotes a candidate above the threshold", async () => {
      const r = await rec({
        usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 82 }] }],
      });
      expect(ids(r)).toEqual(["codex/gpt-6.2-codex", "cursor/claude-opus-7", "opencode/opencode/claude-opus-7-1"]);
      expect(r.usageSource).toBe("none+call");
    });

    it("keeps a candidate below the threshold in place", async () => {
      const r = await rec({
        usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 60 }] }],
      });
      expect(ids(r)[0]).toBe("claudeAgent/claude-opus-7-1");
    });

    it("respects a custom threshold", async () => {
      const p = policyWith({ usage: { thresholds: { weekly: 50 } } });
      expect(p.usage.thresholds.session).toBe(80);
      const r = await rec(
        { usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 60 }] }] },
        p,
      );
      expect(ids(r)[0]).toBe("codex/gpt-6.2-codex");
    });

    it("puts exhausted providers after merely busy ones", async () => {
      const r = await rec(
        {
          usage: [
            { providerInstanceId: "claudeAgent", windows: [{ kind: "session", usedPercent: 100 }] },
            { providerInstanceId: "codex", windows: [{ kind: "session", usedPercent: 90 }] },
          ],
        },
        policyWith({
          maxCandidates: 3,
          fallback: [],
          genericFallback: false,
          taskTypes: {
            code: {
              candidates: [
                { provider: "claudeAgent", family: "claude-opus", effort: "high" },
                { provider: "codex", family: "gpt", effort: "high" },
              ],
            },
          },
        }),
      );
      expect(ids(r)).toEqual(["codex/gpt-6.2-codex", "claudeAgent/claude-opus-7-1"]);
      expect(r.candidates[1]!.reason).toMatch(/exhausted/);
    });

    it("only applies model-scoped windows to those models", async () => {
      const r = await rec({
        usage: [
          {
            providerInstanceId: "claudeAgent",
            windows: [{ kind: "weekly", usedPercent: 95, modelIds: ["claude-sonnet-7-1"] }],
          },
        ],
      });
      expect(ids(r)[0]).toBe("claudeAgent/claude-opus-7-1");
    });

    it("does not demote noDemote candidates below 100%", async () => {
      const p = policyWith({
        taskTypes: {
          code: {
            candidates: [
              { provider: "claudeAgent", family: "claude-opus", effort: "high", noDemote: true },
              { provider: "codex", family: "gpt" },
            ],
          },
        },
      });
      const r = await rec(
        { usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 95 }] }] },
        p,
      );
      expect(ids(r)[0]).toBe("claudeAgent/claude-opus-7-1");
    });

    it("reads percentages from a UsageSource", async () => {
      const source = new StaticUsageSource([
        { providerInstanceId: "claudeAgent", windows: [{ kind: "session", usedPercent: 85 }] },
      ]);
      const r = await rec({}, policy, source);
      expect(r.usageSource).toBe("static");
      expect(ids(r)[0]).toBe("codex/gpt-6.2-codex");
    });
  });

  it("demotes the orchestrator's own provider for independent reviews", async () => {
    const caps = fixture();
    caps.inheritedProviderInstanceId = "codex";
    const r = await rec({ task: "Review the PR", capabilities: caps });
    expect(r.taskType).toBe("review");
    expect(ids(r)).toEqual(["cursor/gemini-5.1-pro", "grok/grok-6", "claudeAgent/claude-opus-7-1"]);
  });

  it("uses the fallback list when no candidate of the type is available", async () => {
    const p = policyWith({
      taskTypes: { code: { candidates: [{ provider: "pi", family: "claude-opus", effort: "low" }] } },
    });
    const r = await rec({}, p);
    expect(r.candidates[0]!.reason).toMatch(/^fallback #1/);
    expect(r.candidates[0]!.source).toBe("fallback");
    // The fallback follows the task type's effort, not its own.
    expect(r.candidates[0]!.options).toEqual([{ id: "effort", value: "low" }]);
    // A driver the user does not have is not reported as a problem.
    expect(r.skipped.some((s) => s.includes("pi"))).toBe(false);
  });

  it("fills the free slots with the fallback list up to maxCandidates", async () => {
    const p = policyWith({
      taskTypes: { code: { candidates: [{ provider: "claudeAgent", family: "claude-opus", effort: "high" }] } },
    });
    const r = await rec({}, p);
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates.map((c) => c.source)).toEqual(["taskType", "fallback", "fallback"]);
    expect(ids(r)).toEqual([
      "claudeAgent/claude-opus-7-1",
      "cursor/claude-opus-7",
      "opencode/opencode/claude-opus-7-1",
    ]);
  });

  it("falls back to the orchestrator's own model when nothing else resolves", async () => {
    const p = policyWith({
      taskTypes: { code: { candidates: [{ provider: "pi", family: "claude-opus" }] } },
      fallback: [],
      genericFallback: false,
    });
    const r = await rec({}, p);
    expect(r.candidates).toEqual([
      expect.objectContaining({
        providerInstanceId: "claudeAgent",
        model: "claude-opus-7-1",
        options: [{ id: "effort", value: "high" }],
        source: "inherited",
        sameAsOrchestrator: true,
      }),
    ]);
    expect(r.candidates[0]!.reason).toMatch(/low confidence/);
  });
});
