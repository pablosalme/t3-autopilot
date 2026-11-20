import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type Capabilities, parseCapabilities } from "../src/capabilities.js";
import { type Recommendation, type RecommendInput, recommendModel } from "../src/recommend.js";
import {
  evaluateProfile,
  isPaidFamily,
  readSubscriptions,
  type Subscriptions,
  validateProfile,
  writeSubscriptions,
} from "../src/subscriptions.js";
import type { UnavailableMark } from "../src/unavailable.js";
import { NoneUsageSource, StaticUsageSource, type UsageSource } from "../src/usage.js";
import { connectServer, defaultPolicy, policyWith, resultText, tempDir } from "./helpers.js";

const policy = defaultPolicy();
const T0 = new Date("2026-11-20T08:00:00Z");

/** Invented setup of the user's real case: Claude, Grok, Cursor and OpenCode, the orchestrator on Claude. */
function setup(only?: string[]): Capabilities {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/subscriptions-setup.json", import.meta.url), "utf8"));
  const caps = parseCapabilities(raw);
  if (only) caps.providers = only.map((id) => caps.providers.find((p) => p.providerInstanceId === id)!);
  return caps;
}

const PAID_ON_CURSOR = [
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "claude-fable",
  "gpt",
  "gpt-mini",
  "gemini",
  "gemini-flash",
  "gemini-flash-lite",
];

/** The user's profiles, as set_subscription would save them. */
const USER: Subscriptions = {
  claudeAgent: { plan: "Claude Max", quota: "generous", role: "primary" },
  grok: {
    plan: "X Subscription Premium ($30)",
    quota: "standard",
    quotaPool: "x-premium",
    quotaWindow: "weekly",
    role: "primary",
    purpose: "main provider for Grok models",
  },
  cursor: {
    plan: "X Subscription Premium ($30), includes Cursor Pro",
    quota: "standard",
    quotaPool: "x-premium",
    quotaWindow: "weekly",
    includedFamilies: ["composer", "grok", "grok-build", "grok-fast"],
    // Explicit, although includedFamilies already implies it: GPT on Cursor never comes out of the weekly quota.
    paidFamilies: PAID_ON_CURSOR,
    purpose: "Grok and Composer from the shared weekly quota; Claude, GPT and Gemini cost extra",
  },
  opencode: {
    plan: "OpenCode Go",
    quota: "tight",
    quotaWindow: "5h",
    role: "experimental",
    purpose: "only models that are not in my other subscriptions",
  },
};
const OPENCODE_GO: Subscriptions = { opencode: USER.opencode! };

const ids = (r: Pick<Recommendation, "candidates">) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
const rec = (
  input: Partial<RecommendInput> & { capabilities: Capabilities },
  p = policy,
  usage: UsageSource = new NoneUsageSource(),
) => recommendModel({ task: "x", taskType: "research", ...input }, p, usage);
const whole = (providerInstanceId: string, reason = "weekly limit reached"): UnavailableMark => ({
  providerInstanceId,
  reason,
  markedAt: T0.toISOString(),
  until: new Date(T0.getTime() + 86_400_000).toISOString(),
});

describe("a tight, experimental subscription (OpenCode Go)", () => {
  // The incident: OpenCode, listed first, had the newest Gemini, and Gemini is also on Cursor.
  const caps = () => setup(["opencode", "cursor"]);

  it("without profiles, the newest Gemini on OpenCode comes first (the behaviour that used up the quota)", async () => {
    const r = await rec({ capabilities: caps() });
    expect(ids(r)[0]).toBe("opencode/opencode-go/gemini-7.5-pro");
    expect(r.setupNeeded).toBeUndefined();
  });

  it("is not proposed for a family the user has on another provider, not even second", async () => {
    const r = await rec({ capabilities: caps(), subscriptions: OPENCODE_GO });
    expect(ids(r)[0]).toBe("cursor/gemini-7-pro");
    expect(ids(r)).not.toContain("opencode/opencode-go/gemini-7.5-pro");
    expect(r.skipped).toContain(
      "opencode/opencode-go/gemini-7.5-pro: left out by its subscription profile (OpenCode Go, quota tight, resets 5h, experimental): gemini is also on cursor",
    );
    // What only it has stays possible, after the unrestricted providers.
    const opencode = r.candidates.filter((c) => c.providerInstanceId === "opencode");
    for (const c of opencode) expect(c.reason).toMatch(/subscription OpenCode Go, quota tight, experimental: fits/);
    expect(r.warnings).toEqual([]);
  });

  it("is not proposed for a large or highly critical task", async () => {
    for (const extra of [{ size: "large" }, { criticality: "high" }] as const) {
      const r = await rec({ capabilities: caps(), subscriptions: OPENCODE_GO, ...extra });
      expect(r.candidates.every((c) => c.providerInstanceId !== "opencode")).toBe(true);
      expect(r.skipped.join("\n")).toMatch(/the task is (large|highly critical)/);
    }
  });

  it("as the only option it is still recommended, with a warning", async () => {
    const r = await rec({ capabilities: setup(["opencode"]), subscriptions: OPENCODE_GO, size: "large" });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => c.providerInstanceId === "opencode")).toBe(true);
    expect(r.candidates[0]!.reason).toMatch(/outside its profile \(the task is large\).*Used only because/);
    expect(r.warnings).toEqual([
      "opencode (OpenCode Go, quota tight, resets 5h, experimental) is recommended outside its subscription profile (the task " +
        "is large) because no other candidate can run. Its quota is tight and may run out quickly. Tell the user " +
        "before delegating.",
    ]);
  });

  it("takes the family when the other provider that has it is marked unavailable", async () => {
    const r = await rec({ capabilities: caps(), subscriptions: OPENCODE_GO, unavailable: [whole("cursor")] });
    expect(ids(r)).toContain("opencode/opencode-go/gemini-7.5-pro");
    expect(r.candidates.find((c) => c.model === "opencode-go/gemini-7.5-pro")?.reason).toMatch(/fits its profile/);
    expect(r.skipped.join("\n")).not.toMatch(/gemini is also on cursor/);
  });

  it("follows onlyFamilies, onlyTaskTypes and avoidFamilies", async () => {
    const only: Subscriptions = { opencode: { plan: "OpenCode Go", quota: "tight", onlyFamilies: ["kimi", "glm"] } };
    const r = await rec({ capabilities: setup(["opencode", "claudeAgent"]), taskType: "code", subscriptions: only });
    const opencode = r.candidates.filter((c) => c.providerInstanceId === "opencode").map((c) => c.model);
    expect(opencode.every((m) => /kimi|glm/.test(m))).toBe(true);
    expect(r.skipped.join("\n")).toMatch(/gemini is not in onlyFamilies \(kimi, glm\)/);

    const types: Subscriptions = { opencode: { plan: "Zen", quota: "standard", onlyTaskTypes: ["quick"] } };
    const r2 = await rec({ capabilities: setup(["opencode", "cursor"]), taskType: "research", subscriptions: types });
    expect(r2.candidates.every((c) => c.providerInstanceId === "cursor")).toBe(true);
    expect(r2.skipped.join("\n")).toMatch(/task type research is not in onlyTaskTypes \(quick\)/);

    const avoid: Subscriptions = { cursor: { plan: "Pro", quota: "generous", avoidFamilies: ["gemini"] } };
    const r3 = await rec({ capabilities: setup(["cursor", "opencode"]), subscriptions: avoid });
    expect(ids(r3)).not.toContain("cursor/gemini-7-pro");
    expect(ids(r3)[0]).toBe("opencode/opencode-go/gemini-7.5-pro");
  });

  it("ranks secondary and lastResort providers after primary ones", async () => {
    const caps2 = setup(["opencode", "cursor"]);
    const geminiOnly = policyWith({
      taskTypes: { research: { candidates: [{ provider: "*", family: "gemini" }] } },
      fallback: [],
      genericFallback: false,
    });
    expect(ids(await rec({ capabilities: caps2 }, geminiOnly))[0]).toBe("opencode/opencode-go/gemini-7.5-pro");
    const secondary = await rec(
      { capabilities: caps2, subscriptions: { opencode: { plan: "Zen", quota: "generous", role: "secondary" } } },
      geminiOnly,
    );
    expect(ids(secondary)[0]).toBe("cursor/gemini-7-pro");
    expect(secondary.candidates.find((c) => c.providerInstanceId === "opencode")?.reason).toMatch(
      /ranked after primary subscriptions/,
    );
    const last = await rec(
      { capabilities: caps2, subscriptions: { opencode: { plan: "Zen", quota: "generous", role: "lastResort" } } },
      geminiOnly,
    );
    expect(last.candidates.at(-1)?.providerInstanceId).toBe("opencode");
  });
});

describe("one plan for Grok and Cursor (quotaPool, includedFamilies)", () => {
  // Composer on Cursor first, then Claude Haiku: shows Cursor moving down when the shared quota is out.
  const composerFirst = policyWith({
    taskTypes: {
      quick: {
        candidates: [
          { provider: "cursor", family: "composer" },
          { provider: "claudeAgent", family: "claude-haiku", effort: "low" },
        ],
      },
    },
    fallback: [],
    genericFallback: false,
  });

  it("never proposes Claude, GPT or Gemini on Cursor while an included model can run", async () => {
    for (const taskType of ["review", "design", "code", "quick", "research", "debug", "plan", "writing"]) {
      const r = await rec({ capabilities: setup(), taskType, subscriptions: USER });
      expect(
        ids(r).filter((id) => /^cursor\/(claude|gpt|gemini)/.test(id)),
        taskType,
      ).toEqual([]);
      expect(r.warnings, taskType).toEqual([]);
    }
    const review = await rec({ capabilities: setup(), taskType: "review", subscriptions: USER });
    expect(ids(review)[0]).toBe("grok/grok-8.1");
    expect(review.skipped).toContain(
      "cursor/gpt-9.1-sol: left out by its subscription profile (X Subscription Premium ($30), includes Cursor Pro, " +
        "quota standard, pool x-premium, resets weekly): extra cost: gpt is billed apart from the plan (paidFamilies)",
    );
    const quick = await rec({ capabilities: setup(), taskType: "quick", subscriptions: USER });
    expect(quick.candidates.find((c) => c.model === "composer-4")?.reason).toMatch(
      /fits its profile \(included in the plan: composer\)/,
    );
  });

  it("OpenCode Go takes the models no other subscription includes, after the others", async () => {
    // Cursor's GPT is billed apart, so the user has no GPT: OpenCode's GPT fits its profile.
    const r = await rec({ capabilities: setup(["cursor", "opencode"]), taskType: "review", subscriptions: USER });
    expect(ids(r)).toContain("opencode/openai/gpt-9.1-sol");
    expect(ids(r)[0]).toBe("cursor/grok-8");
  });

  it("a limit on Grok applies to Cursor's included models, not to its paid ones", async () => {
    const caps = setup(["claudeAgent", "grok", "cursor"]);
    const before = await rec({ capabilities: caps, taskType: "quick", subscriptions: USER }, composerFirst);
    expect(ids(before)[0]).toBe("cursor/composer-4");
    const r = await rec(
      {
        capabilities: caps,
        taskType: "quick",
        subscriptions: USER,
        unavailable: [whole("grok", "weekly limit of the X plan reached")],
      },
      composerFirst,
    );
    expect(ids(r)).toEqual(["claudeAgent/claude-haiku-9-0", "cursor/composer-4"]);
    const composer = r.candidates.find((c) => c.model === "composer-4");
    expect(composer?.reason).toMatch(
      /shares quota pool "x-premium" with grok, marked unavailable until .*: weekly limit of the X plan reached; ranked after available candidates/,
    );
    // Without the pool, a mark on Grok says nothing about Cursor.
    const { quotaPool: _pool, ...cursorAlone } = USER.cursor!;
    const apart = await rec(
      {
        capabilities: caps,
        taskType: "quick",
        subscriptions: { ...USER, cursor: cursorAlone },
        unavailable: [whole("grok")],
      },
      composerFirst,
    );
    expect(ids(apart)[0]).toBe("cursor/composer-4");
  });

  it("usage reported for Grok counts for Cursor too", async () => {
    const usage = new StaticUsageSource([
      { providerInstanceId: "grok", windows: [{ kind: "weekly", usedPercent: 100, resetsAt: "2026-11-23T00:00:00Z" }] },
    ]);
    const r = await rec(
      { capabilities: setup(["claudeAgent", "grok", "cursor"]), taskType: "quick", subscriptions: USER },
      composerFirst,
      usage,
    );
    expect(r.candidates.find((c) => c.model === "composer-4")?.reason).toMatch(/weekly usage exhausted/);
    expect(ids(r)[0]).toBe("claudeAgent/claude-haiku-9-0");
  });

  it("a paid model comes only after the included ones, marked or not, with a warning", async () => {
    // Only Cursor, and the shared weekly quota is used up: what is included is marked, the rest costs extra.
    const r = await rec({
      capabilities: setup(["cursor"]),
      taskType: "design",
      subscriptions: USER,
      unavailable: [whole("grok")],
    });
    expect(ids(r)).toEqual(["cursor/grok-8", "cursor/default", "cursor/gemini-7-pro"]);
    expect(r.candidates[0]!.reason).toMatch(/shares quota pool "x-premium" with grok, marked unavailable/);
    expect(r.candidates[2]!.reason).toMatch(/extra cost: gemini is billed apart.*Used only because/);
    expect(r.warnings).toEqual([
      "cursor/gemini-7-pro (X Subscription Premium ($30), includes Cursor Pro, quota standard, pool x-premium, resets weekly) " +
        "costs extra: gemini is billed apart from the plan (paidFamilies), so it is paid at API " +
        "prices or from prepaid credit. It is recommended only because no included model is free to run. Ask the " +
        "user before delegating.",
      "cursor/grok-8, cursor/default fit their subscription but are marked unavailable or out of quota, so the child " +
        "may not start. They come first because they cost nothing extra; if a child cannot start, take the next candidate.",
      "Every candidate is marked unavailable, out of quota or costs extra. Before delegating to one that costs extra " +
        "(cursor/gemini-7-pro, cursor/claude-opus-9-1, cursor/gpt-9.1-sol), ask the user whether to pay for it, wait " +
        "until 2026-11-21T08:00:00.000Z (when the mark on grok (every model) ends) or use another provider.",
    ]);
    expect(r.skipped).toContain(
      "cursor/gpt-9.1-sol: costs extra (gpt is billed apart from the plan (paidFamilies)); left out of the list after " +
        "the models the plans include",
    );
  });

  it("paidFamilies works like a missing includedFamilies entry, and a model of no family is not paid", () => {
    const paid: Subscriptions[string] = { plan: "Pro", quota: "standard", paidFamilies: ["gpt"] };
    expect(isPaidFamily(paid, "gpt")).toBe(true);
    expect(isPaidFamily(paid, "composer")).toBe(false);
    expect(isPaidFamily(USER.cursor!, "gemini")).toBe(true);
    expect(isPaidFamily(USER.cursor!, undefined)).toBe(false);
  });
});

describe("today's state: OpenCode out of credits and its Go plan at its 5-hour limit", () => {
  const until = (h: number) => new Date(T0.getTime() + h * 3_600_000).toISOString();
  const prefixMark = (model: string, reason: string, h: number): UnavailableMark => ({
    providerInstanceId: "opencode",
    model,
    reason,
    markedAt: T0.toISOString(),
    until: until(h),
  });
  const today = [
    prefixMark("opencode/*", "out of credits", 24),
    prefixMark("opencode-go/*", "5-hour limit of OpenCode Go reached", 5),
  ];

  it("a mark on a model prefix covers that plan's models only", async () => {
    const r = await rec({ capabilities: setup(["opencode"]), taskType: "code", unavailable: today });
    const reasons = Object.fromEntries(r.candidates.map((c) => [c.model, c.reason]));
    for (const [model, reason] of Object.entries(reasons)) {
      if (model.startsWith("opencode/")) expect(reason).toMatch(/marked unavailable .*out of credits/);
      else if (model.startsWith("opencode-go/")) expect(reason).toMatch(/marked unavailable .*5-hour limit/);
      else expect(reason).not.toMatch(/marked unavailable/);
    }
    // Models of other prefixes (billed elsewhere) come first.
    expect(r.candidates[0]!.model).not.toMatch(/^opencode(-go)?\//);
  });

  it("with the user's profiles, neither OpenCode nor GPT on Cursor is proposed", async () => {
    for (const taskType of ["review", "code", "research", "quick"]) {
      const r = await rec({ capabilities: setup(), taskType, subscriptions: USER, unavailable: today });
      expect(
        ids(r).filter((id) => /^opencode\/(opencode|opencode-go)\//.test(id)),
        taskType,
      ).toEqual([]);
      expect(
        ids(r).filter((id) => /^cursor\/gpt/.test(id)),
        taskType,
      ).toEqual([]);
    }
    const quick = await rec({ capabilities: setup(), taskType: "quick", subscriptions: USER, unavailable: today });
    expect(quick.skipped.join("\n")).toMatch(
      /cursor\/gpt-8\.4-mini: .*extra cost: gpt-mini is billed apart from the plan \(paidFamilies\)/,
    );
  });
});

describe("setupNeeded", () => {
  it("lists eligible providers without a profile, with the questions to ask, and does not block", async () => {
    const r = await rec({ capabilities: setup(), subscriptions: { claudeAgent: USER.claudeAgent! } });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.setupNeeded?.providers.map((p) => p.providerInstanceId)).toEqual(["grok", "cursor", "opencode"]);
    const cursor = r.setupNeeded!.providers[1]!;
    expect(cursor).toMatchObject({ driverKind: "cursor", displayName: "Cursor" });
    expect(cursor.families).toEqual(expect.arrayContaining(["composer", "grok", "gemini", "claude-opus"]));
    expect(cursor.questions.join("\n")).toMatch(/Which plan do you have on Cursor \(cursor\)\?/);
    expect(cursor.questions.join("\n")).toMatch(/generous.*standard.*tight/);
    expect(cursor.questions.join("\n")).toMatch(/share one quota/);
    expect(cursor.questions.join("\n")).toMatch(/billed apart/);
    expect(r.setupNeeded!.instructions).toMatch(/set_subscription/);
  });

  it("is absent once every eligible provider has a profile, and ignores providers that cannot run", async () => {
    expect((await rec({ capabilities: setup(), subscriptions: USER })).setupNeeded).toBeUndefined();
    const caps = setup();
    caps.providers.find((p) => p.providerInstanceId === "opencode")!.canRunChildTask = false;
    const { opencode: _, ...rest } = USER;
    expect((await rec({ capabilities: caps, subscriptions: rest })).setupNeeded).toBeUndefined();
  });

  it("warns about a profile that names a family the policy no longer has", async () => {
    const stale: Subscriptions = { ...USER, opencode: { plan: "OpenCode Go", quota: "tight", onlyFamilies: ["nope"] } };
    const r = await rec({ capabilities: setup(), subscriptions: stale });
    expect(r.warnings.join("\n")).toMatch(
      /opencode: its subscription profile names onlyFamilies: unknown family "nope"/,
    );
  });
});

describe("profiles on disk", () => {
  it("validates strictly, with every problem in one message", () => {
    const at = T0;
    expect(() => validateProfile({ providerInstanceId: "opencode", plan: "Go" }, policy, at)).toThrow(
      /set_subscription needs quota/,
    );
    expect(() => validateProfile({ providerInstanceId: "o", plan: "Go", quota: "small" as never }, policy, at)).toThrow(
      /quota: one of generous, standard, tight/,
    );
    expect(() =>
      validateProfile(
        { providerInstanceId: "o", plan: "Go", quota: "tight", onlyFamilies: ["kimi"], avoidFamilies: ["gpt"] },
        policy,
        at,
      ),
    ).toThrow(/use one or the other/);
    expect(() =>
      validateProfile(
        { providerInstanceId: "o", plan: "X", quota: "standard", includedFamilies: ["grok"], paidFamilies: ["grok"] },
        policy,
        at,
      ),
    ).toThrow(/cannot be in both/);
    const unknown = () =>
      validateProfile(
        { providerInstanceId: "o", plan: "X", quota: "standard", paidFamilies: ["gemmini"], onlyTaskTypes: ["chat"] },
        policy,
        at,
      );
    expect(unknown).toThrow(/paidFamilies: unknown family "gemmini"/);
    expect(unknown).toThrow(/onlyTaskTypes: unknown task type "chat"/);
    expect(unknown).toThrow(/known families: claude-opus/);
    expect(() => validateProfile({ providerInstanceId: "o", plan: " ", quota: "tight" }, policy, at)).toThrow(/plan:/);
    expect(() =>
      validateProfile({ providerInstanceId: "o", plan: "Go", quota: "tight", quotaWindow: "hourly" }, policy, at),
    ).toThrow(/quotaWindow: one of 5h, weekly, monthly/);
    expect(() =>
      validateProfile({ providerInstanceId: "o", plan: "Go", quota: "tight", onlyFamilies: [] }, policy, at),
    ).toThrow(/onlyFamilies: an empty list/);
    expect(validateProfile({ providerInstanceId: "o", plan: " Go ", quota: "tight" }, policy, at)).toEqual({
      plan: "Go",
      quota: "tight",
      updatedAt: T0.toISOString(),
    });
  });

  it("writes YAML readable by its owner only, and reads it back", () => {
    const path = join(tempDir(), "subscriptions.yaml");
    expect(readSubscriptions(path)).toEqual({ subscriptions: {} });
    writeSubscriptions(path, USER);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^# t3-autopilot subscription profiles/);
    expect(parse(text)).toMatchObject({ version: 1, subscriptions: { opencode: { plan: "OpenCode Go" } } });
    expect(readSubscriptions(path)).toEqual({ subscriptions: USER });
  });

  it("the example in both READMEs is a valid file, the user's profiles", () => {
    for (const file of ["README.md", "docs/README.es.md"]) {
      const readme = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const block = /```yaml\n(version: 1\nsubscriptions:\n[\s\S]*?)```/.exec(readme)?.[1];
      expect(block, file).toBeDefined();
      const path = join(tempDir(), "subscriptions.yaml");
      writeFileSync(path, block!);
      expect(readSubscriptions(path), file).toEqual({ subscriptions: USER });
      for (const profile of Object.values(USER)) {
        expect(() => validateProfile({ providerInstanceId: "x", ...profile }, policy, T0)).not.toThrow();
      }
    }
  });

  it("reports an invalid file instead of using it", () => {
    const path = join(tempDir(), "subscriptions.yaml");
    writeFileSync(path, "version: 1\nsubscriptions:\n  opencode: { plan: Go, quota: tiny }\n");
    expect(readSubscriptions(path).error).toMatch(/quota: one of generous, standard, tight/);
    writeFileSync(path, "version: 1\nsubscriptions: [\n");
    expect(readSubscriptions(path).error).toMatch(/cannot read it as YAML/);
    writeFileSync(path, "");
    expect(readSubscriptions(path)).toEqual({ subscriptions: {} });
  });

  it("evaluateProfile leaves a primary, standard profile without effect", () => {
    const check = {
      family: "gpt",
      taskType: "code",
      size: "medium",
      criticality: "normal",
      familyElsewhere: [],
    } as const;
    expect(evaluateProfile({ plan: "Plus", quota: "standard" }, check)).toEqual({ tier: 0, outside: [] });
  });
});

describe("set_subscription and get_subscriptions", () => {
  type Rec = { setupNeeded?: { providers: { providerInstanceId: string }[] }; warnings: string[] };

  it("saves the user's answers, and recommend_model stops asking for that provider", async () => {
    const { client, home } = await connectServer(undefined, { now: () => T0 });
    const first = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "research", capabilities: setup() },
    });
    const before = first.structuredContent as Rec;
    expect(before.setupNeeded?.providers.map((p) => p.providerInstanceId)).toEqual([
      "claudeAgent",
      "grok",
      "cursor",
      "opencode",
    ]);

    const saved = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", ...USER.opencode },
    });
    expect(saved.isError, resultText(saved)).toBeFalsy();
    expect(saved.structuredContent).toMatchObject({
      saved: { providerInstanceId: "opencode", plan: "OpenCode Go", quota: "tight", updatedAt: T0.toISOString() },
      file: join(home, "subscriptions.yaml"),
      missing: ["claudeAgent", "grok", "cursor"],
      warnings: [],
    });
    const pooled = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "grok", ...USER.grok },
    });
    expect((pooled.structuredContent as { warnings: string[] }).warnings[0]).toMatch(/No other provider has quotaPool/);
    const ghost = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "ghost", plan: "x", quota: "standard" },
    });
    expect((ghost.structuredContent as { warnings: string[] }).warnings[0]).toMatch(/ghost is not in the last/);

    const after = (await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "research" } }))
      .structuredContent as Rec;
    expect(after.setupNeeded?.providers.map((p) => p.providerInstanceId)).toEqual(["claudeAgent", "cursor"]);

    const got = await client.callTool({ name: "get_subscriptions", arguments: {} });
    expect(got.structuredContent).toMatchObject({
      subscriptions: { opencode: { plan: "OpenCode Go" }, grok: { quotaPool: "x-premium" }, ghost: { plan: "x" } },
      missing: ["claudeAgent", "cursor"],
    });
    expect(readSubscriptions(join(home, "subscriptions.yaml")).subscriptions.opencode?.role).toBe("experimental");
  });

  it("rejects invalid answers without touching the file, and removes a profile", async () => {
    const { client, home } = await connectServer();
    const bad = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", plan: "OpenCode Go", quota: "tight", onlyFamilies: ["gemmini"] },
    });
    expect(bad.isError).toBe(true);
    expect(resultText(bad)).toMatch(/onlyFamilies: unknown family "gemmini"/);
    const missing = await client.callTool({ name: "set_subscription", arguments: { providerInstanceId: "opencode" } });
    expect(resultText(missing)).toMatch(/needs plan and quota \(or remove: true\)/);
    const wrongEnum = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", plan: "Go", quota: "tiny" },
    });
    expect(wrongEnum.isError).toBe(true);
    expect(readSubscriptions(join(home, "subscriptions.yaml"))).toEqual({ subscriptions: {} });

    const noCaps = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", plan: "Go", quota: "tight" },
    });
    expect((noCaps.structuredContent as { missing: unknown }).missing).toBeNull();
    const extra = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", remove: true, plan: "Go" },
    });
    expect(resultText(extra)).toMatch(/remove: true takes only providerInstanceId, not plan/);
    const removed = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", remove: true },
    });
    expect(removed.structuredContent).toMatchObject({ removed: { providerInstanceId: "opencode" }, subscriptions: {} });
    const again = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", remove: true },
    });
    expect(again.structuredContent).toMatchObject({ removed: null });
  });

  it("an invalid file is reported, never overwritten, and recommend_model keeps working", async () => {
    const { client, home } = await connectServer();
    const path = join(home, "subscriptions.yaml");
    writeFileSync(path, "version: 2\n");
    const r = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "research", capabilities: setup() },
    });
    expect(r.isError).toBeFalsy();
    const data = r.structuredContent as Rec;
    expect(data.setupNeeded).toBeUndefined();
    expect(data.warnings.join("\n")).toMatch(/Subscription profiles are ignored until the file is fixed/);
    const set = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "opencode", plan: "Go", quota: "tight" },
    });
    expect(resultText(set)).toMatch(/it was not changed/);
    expect(readFileSync(path, "utf8")).toBe("version: 2\n");
    const got = await client.callTool({ name: "get_subscriptions", arguments: {} });
    expect(got.isError).toBe(true);
  });

  it("mark_unavailable lasts the profile's quotaWindow by default, or its quota pool's", async () => {
    const { client } = await connectServer(undefined, { now: () => T0 });
    const set = (providerInstanceId: string, profile: object) =>
      client.callTool({ name: "set_subscription", arguments: { providerInstanceId, ...profile } });
    await set("opencode", USER.opencode!);
    await set("grok", USER.grok!);
    const { quotaWindow: _w, ...cursorNoWindow } = USER.cursor!;
    await set("cursor", cursorNoWindow);
    const mark = async (args: object) =>
      (await client.callTool({ name: "mark_unavailable", arguments: { reason: "limit", ...args } }))
        .structuredContent as { marked: { until: string }; untilFrom: string };
    const hoursFromT0 = (iso: string) => (Date.parse(iso) - T0.getTime()) / 3_600_000;

    const go = await mark({ providerInstanceId: "opencode", model: "opencode-go/*" });
    expect(hoursFromT0(go.marked.until)).toBe(5);
    expect(go.untilFrom).toBe("quotaWindow 5h of opencode's subscription profile");
    const pooled = await mark({ providerInstanceId: "cursor" });
    expect(hoursFromT0(pooled.marked.until)).toBe(168);
    expect(pooled.untilFrom).toBe("quotaWindow weekly of grok's subscription profile");
    const none = await mark({ providerInstanceId: "codex" });
    expect(hoursFromT0(none.marked.until)).toBe(24);
    expect(none.untilFrom).toBe("default 24 h");
    const given = await mark({ providerInstanceId: "opencode", until: "2026-11-20T09:30:00Z" });
    expect(hoursFromT0(given.marked.until)).toBe(1.5);
    expect(given.untilFrom).toBe("until");

    const monthly = await set("pi", { plan: "Pay as you go", quota: "standard", quotaWindow: "monthly" });
    expect(monthly.isError).toBeFalsy();
    expect(hoursFromT0((await mark({ providerInstanceId: "pi" })).marked.until)).toBe(720);
    const bad = await set("pi", { plan: "x", quota: "standard", quotaWindow: "daily" });
    expect(bad.isError).toBe(true);
  });

  it("validates family names against the user's policy", async () => {
    const home = tempDir();
    writeFileSync(join(home, "policy.yaml"), "families:\n  devstral:\n    match: { '*': '^devstral-(\\d+)$' }\n");
    const { client } = await connectServer(home);
    const ok = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "acp", plan: "Free", quota: "tight", onlyFamilies: ["devstral"] },
    });
    expect(ok.isError, resultText(ok)).toBeFalsy();
    const elsewhere = await connectServer();
    const rejected = await elsewhere.client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "acp", plan: "Free", quota: "tight", onlyFamilies: ["devstral"] },
    });
    expect(resultText(rejected)).toMatch(/unknown family "devstral"/);
  });
});

describe("the user's real capabilities of 2026-11-20, with Grok's weekly limit reached", () => {
  /** orchestrator_capabilities as T3 returned it that day (thread id invented); the orchestrator on Claude Opus. */
  const real = () =>
    parseCapabilities(
      JSON.parse(readFileSync(new URL("./fixtures/capabilities-2026-11-20.json", import.meta.url), "utf8")),
    );
  const review = (
    input: Omit<Partial<RecommendInput>, "capabilities"> & { capabilities?: Capabilities } = {},
    p = policy,
  ) =>
    rec({ capabilities: real(), taskType: "review", subscriptions: USER, unavailable: [whole("grok")], ...input }, p);

  it("a generic, low-confidence model on the experimental provider does not jump ahead of Claude", async () => {
    const r = await review();
    expect(ids(r)).toEqual([
      "claudeAgent/claude-opus-5-5",
      "claudeAgent/claude-sonnet-5-5",
      "opencode/opencode-go/beam-free",
    ]);
    expect(r.candidates[0]!.reason).toMatch(/same provider as the orchestrator; demoted for an independent review/);
    expect(r.candidates[2]!.reason).toMatch(/generic fallback \(low confidence.*experimental: fits its profile/);
    expect(r.warnings.filter((w) => !/left out \d+ models/.test(w))).toEqual([]);
  });

  it("the independent-review rule still puts another primary provider first", async () => {
    const r = await review({ unavailable: [] });
    expect(ids(r)).toEqual(["grok/grok-4.7", "cursor/grok-4.7", "grok/grok-4.7-build-fast"]);
  });

  describe("with Claude and OpenCode in excludeProviders", () => {
    const excluded = policyWith({ excludeProviders: ["claudeAgent", "opencode"] });

    it("puts what the plan includes first, although marked, and what costs extra last, with a warning", async () => {
      const r = await review({}, excluded);
      expect(ids(r)).toEqual(["grok/grok-4.7", "cursor/grok-4.7", "cursor/gemini-4-neon"]);
      expect(r.candidates[0]!.reason).toMatch(
        /marked unavailable until .*; quota may be exhausted; no available candidate ranks higher/,
      );
      expect(r.candidates[1]!.reason).toMatch(
        /shares quota pool "x-premium" with grok, .*; quota may be exhausted; no available candidate ranks higher/,
      );
      expect(r.candidates[2]!.reason).toMatch(/extra cost: gemini is billed apart.*Used only because/);
      const warnings = r.warnings.filter((w) => !/left out \d+ models/.test(w));
      expect(warnings[1]).toBe(
        "grok/grok-4.7, cursor/grok-4.7 fit their subscription but are marked unavailable or out of quota, so the " +
          "child may not start. They come first because they cost nothing extra; if a child cannot start, take the " +
          "next candidate.",
      );
      expect(warnings[2]).toMatch(
        /^Every candidate is marked unavailable, out of quota or costs extra\. Before delegating to one that costs extra \(cursor\/gemini-4-neon, cursor\/claude-opus-5-5\), ask the user whether to pay for it, wait until .* \(when the mark on grok \(every model\) ends\) or use another provider\.$/,
      );
      expect(r.skipped).toContain(
        "cursor/claude-opus-5-5: costs extra (claude-opus is billed apart from the plan (paidFamilies)); left out of the " +
          "list after the models the plans include",
      );
    });

    it("never puts a paid and marked model ahead of an included one that is only marked", async () => {
      // Cursor alone, marked as a whole: its paid models are marked too, and its included ones only marked.
      const caps = real();
      caps.providers = caps.providers.filter((p) => p.providerInstanceId === "cursor");
      const r = await review({ capabilities: caps, unavailable: [whole("cursor")] }, excluded);
      expect(ids(r)).toEqual(["cursor/grok-4.7", "cursor/default", "cursor/gemini-4-neon"]);
      expect(r.candidates[2]!.reason).toMatch(/marked unavailable until.*extra cost: gemini/);
      expect(r.warnings.join("\n")).toMatch(
        /ask the user whether to pay for it, wait until .* \(when the mark on cursor/,
      );
    });
  });
});
