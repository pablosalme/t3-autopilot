import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentProvider, loadCatalog } from "../src/catalog.js";
import { type RecommendInput, recommendModel } from "../src/recommend.js";
import type { SubscriptionProfile } from "../src/subscriptions.js";
import { NoneUsageSource } from "../src/usage.js";
import { defaultPolicy, tempDir } from "./helpers.js";

// The engine reads the families that models of the agent catalog declare (`policyFamily`): the alias `opus` is a
// claude-opus model and Codex's `default` a GPT, though no family regex matches either id.

const policy = defaultPolicy();
const catalog = loadCatalog({
  userPath: join(tempDir(), "missing.yaml"),
  families: Object.keys(policy.families),
}).catalog;
const agents = (...ids: string[]) => ids.map((id) => agentProvider(catalog, "herdr", id));
const recommend = (input: Omit<RecommendInput, "task">) =>
  recommendModel({ task: "x", ...input }, policy, new NoneUsageSource());

describe("the engine with providers built from the agent catalog", () => {
  const capabilities = {
    inheritedProviderInstanceId: "claude",
    inheritedModel: "opus",
    providers: agents("claude", "codex", "grok"),
  };

  it("resolves a task type's families to the aliases that declare them", async () => {
    const code = await recommend({ taskType: "code", capabilities });
    expect(code.candidates.map((c) => [c.providerInstanceId, c.model, c.reason])).toEqual([
      ["claude", "opus", "code #1: latest claude-opus on claude is opus, effort high"],
      ["codex", "default", "code #2: latest gpt on codex is default, effort high"],
      ["grok", "default", "code #4: latest grok-build on grok is default, effort high"],
    ]);
    expect(code.candidates[0]?.sameAsOrchestrator).toBe(true);
    const review = await recommend({ taskType: "review", capabilities });
    expect(review.candidates[0]).toMatchObject({ providerInstanceId: "codex", model: "default" });
    expect(review.candidates.at(-1)?.reason).toMatch(/same provider as the orchestrator; demoted/);
  });

  it("names the declared families in setupNeeded", async () => {
    const { setupNeeded } = await recommend({ taskType: "code", capabilities, subscriptions: {} });
    expect(setupNeeded?.providers.map((p) => [p.providerInstanceId, p.families])).toEqual([
      ["claude", ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"]],
      ["codex", ["gpt"]],
      ["grok", ["grok-build"]],
    ]);
  });

  it("gives the generic fallback's model its declared family, so subscription profiles apply to it", async () => {
    const solo = {
      providers: [
        {
          providerInstanceId: "x",
          driverKind: "x",
          models: [{ id: "fast", policyFamily: "grok-fast" }],
          canRunChildTask: true,
        },
      ],
    };
    const profile = { plan: "Plan", quota: "standard", avoidFamilies: ["grok-fast"] } as SubscriptionProfile;
    const result = await recommend({ taskType: "writing", capabilities: solo, subscriptions: { x: profile } });
    expect(result.candidates[0]).toMatchObject({ providerInstanceId: "x", model: "fast", source: "generic" });
    expect(result.warnings).toEqual([
      "x (Plan, quota standard) is recommended outside its subscription profile (grok-fast is in avoidFamilies) " +
        "because no other candidate can run. Tell the user before delegating.",
    ]);
  });
});
