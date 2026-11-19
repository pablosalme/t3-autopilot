import { describe, expect, it } from "vitest";
import { compareVersions, resolveFamily, resolveFamilyDetail, versionKey } from "../src/families.js";
import { defaultPolicy, fixture } from "./helpers.js";

const policy = defaultPolicy();
const provider = (id: string, caps = fixture()) => caps.providers.find((p) => p.providerInstanceId === id)!;
const family = (name: string) => policy.families[name]!;

describe("version keys", () => {
  it("uses numeric capture groups, or every number without them", () => {
    expect(versionKey("claude-opus-7-1", /^claude-opus-(\d+)(?:-(\d+))?$/.exec("claude-opus-7-1")!)).toEqual([7, 1]);
    expect(versionKey("claude-opus-7", /^claude-opus-(\d+)(?:-(\d+))?$/.exec("claude-opus-7")!)).toEqual([7]);
    expect(versionKey("grok-5.9", /^grok-.*$/.exec("grok-5.9")!)).toEqual([5, 9]);
  });

  it("orders 7.1 > 7 > 6.9 and 5.10 > 5.9", () => {
    expect(compareVersions([7, 1], [7])).toBeGreaterThan(0);
    expect(compareVersions([7], [6, 9])).toBeGreaterThan(0);
    expect(compareVersions([5, 10], [5, 9])).toBeGreaterThan(0);
    expect(compareVersions([6], [6])).toBe(0);
  });
});

describe("resolveFamily", () => {
  it("picks the most recent model of the family on each provider", () => {
    expect(resolveFamily(family("claude-opus"), provider("claudeAgent"))?.id).toBe("claude-opus-7-1");
    expect(resolveFamily(family("claude-opus"), provider("cursor"))?.id).toBe("claude-opus-7");
    expect(resolveFamily(family("claude-opus"), provider("opencode"))?.id).toBe("opencode/claude-opus-7-1");
    expect(resolveFamily(family("gpt"), provider("codex"))?.id).toBe("gpt-6.2-codex");
    expect(resolveFamily(family("gemini"), provider("cursor"))?.id).toBe("gemini-5.1-pro");
  });

  it("keeps sibling families apart", () => {
    expect(resolveFamily(family("grok"), provider("grok"))?.id).toBe("grok-6");
    expect(resolveFamily(family("grok-build"), provider("grok"))?.id).toBe("grok-6-build-fast");
    expect(resolveFamily(family("claude-sonnet"), provider("claudeAgent"))?.id).toBe("claude-sonnet-7-1");
  });

  it("picks up a new model of an existing family with no code or policy change", () => {
    const caps = fixture();
    const claude = provider("claudeAgent", caps);
    // T3 lists the new model last; order must not matter.
    claude.models.push({ id: "claude-opus-7-2", label: "Claude Opus 7.2", options: [] });
    expect(resolveFamily(family("claude-opus"), claude)?.id).toBe("claude-opus-7-2");

    const codex = provider("codex", caps);
    codex.models.unshift({ id: "gpt-6.10-codex" });
    expect(resolveFamily(family("gpt"), codex)?.id).toBe("gpt-6.10-codex");
  });

  it("returns undefined when the provider has no model of the family or no pattern for its driver", () => {
    expect(resolveFamily(family("gemini"), provider("claudeAgent"))).toBeUndefined();
    expect(resolveFamily(family("claude-haiku"), provider("cursor"))).toBeUndefined();
  });

  it("honours exclude", () => {
    const fam = { match: { claudeAgent: "^claude-opus-(\\d+)(?:-(\\d+))?$" }, exclude: "-7-1$" };
    expect(resolveFamily(fam, provider("claudeAgent"))?.id).toBe("claude-opus-7");
  });
});

describe("review regressions", () => {
  const p = (ids: string[], driverKind = "claudeAgent") => ({
    providerInstanceId: "p",
    driverKind,
    models: ids.map((id) => ({ id })),
    canRunChildTask: true,
  });

  it("a dated snapshot id does not beat a newer version (#5)", () => {
    expect(resolveFamily(family("claude-opus"), p(["claude-opus-4-20250514", "claude-opus-4-8"]))?.id).toBe(
      "claude-opus-4-8",
    );
    expect(resolveFamily(family("claude-sonnet"), p(["claude-sonnet-4-5-20250929", "claude-sonnet-4-6"]))?.id).toBe(
      "claude-sonnet-4-6",
    );
    expect(versionKey("claude-opus-4-20250514", /^(.*)$/.exec("claude-opus-4-20250514")!)).toEqual([4]);
  });

  it("keeps Gemini pro, flash and flash-lite apart (#9)", () => {
    const ids = ["gemini-3.5-flash-lite", "gemini-3-pro", "gemini-3.5-flash"];
    expect(resolveFamily(family("gemini"), p(ids, "cursor"))?.id).toBe("gemini-3-pro");
    expect(resolveFamily(family("gemini-flash"), p(ids, "cursor"))?.id).toBe("gemini-3.5-flash");
    expect(resolveFamily(family("gemini-flash-lite"), p(ids, "cursor"))?.id).toBe("gemini-3.5-flash-lite");
  });

  it("resolves OpenCode and Pi provider prefixes beyond opencode/ (#9)", () => {
    expect(resolveFamily(family("claude-opus"), p(["anthropic/claude-opus-4-5"], "opencode"))?.id).toBe(
      "anthropic/claude-opus-4-5",
    );
    expect(resolveFamily(family("claude-opus"), p(["openrouter/anthropic/claude-opus-4.6"], "opencode"))?.id).toBe(
      "openrouter/anthropic/claude-opus-4.6",
    );
    expect(resolveFamily(family("gpt"), p(["openai/gpt-5", "openai/gpt-5.4"], "pi"))?.id).toBe("openai/gpt-5.4");
  });

  it("matches Codex's named flagship models and keeps the small ones apart", () => {
    const ids = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.4-mini", "gpt-5.3-codex-spark"];
    expect(resolveFamily(family("gpt"), p(ids, "codex"))?.id).toBe("gpt-6.1-sol");
    expect(resolveFamily(family("gpt-mini"), p(ids, "codex"))?.id).toBe("gpt-6-luna");
  });

  it("matches dated Gemini ids without counting the date as a version", () => {
    const dated = ["gemini-2.5-pro-preview-06-05", "gemini-2.0-pro", "gemini-2.5-pro-exp-03-25"];
    expect(resolveFamilyDetail(family("gemini"), p(dated, "cursor"))).toMatchObject({
      model: { id: "gemini-2.5-pro-preview-06-05" },
      ties: 1,
    });
    expect(resolveFamily(family("gemini"), p([...dated, "gemini-3-pro"], "cursor"))?.id).toBe("gemini-3-pro");
    expect(resolveFamily(family("gemini"), p(["google/gemini-2.5-pro-preview-06-05"], "opencode"))?.id).toBe(
      "google/gemini-2.5-pro-preview-06-05",
    );
    const flash = ["gemini-2.0-flash-001", "gemini-2.5-flash-preview-09-2025", "gemini-2.5-flash-lite-preview-06-17"];
    expect(resolveFamily(family("gemini"), p(flash, "cursor"))).toBeUndefined();
    expect(resolveFamily(family("gemini-flash"), p(flash, "cursor"))?.id).toBe("gemini-2.5-flash-preview-09-2025");
    expect(resolveFamily(family("gemini-flash-lite"), p(flash, "cursor"))?.id).toBe(
      "gemini-2.5-flash-lite-preview-06-17",
    );
  });

  it("breaks a version tie by T3's order and counts the tied models", () => {
    const tiers = ["gemini-9-neon", "gemini-9-carbon", "gemini-9-hydrogen", "gemini-9-argon", "gemini-8.5-pro"];
    expect(resolveFamilyDetail(family("gemini"), p(tiers, "cursor"))).toMatchObject({
      model: { id: "gemini-9-neon" },
      ties: 3,
    });
    expect(resolveFamilyDetail(family("gemini"), p(tiers.slice(3), "cursor"))).toMatchObject({
      model: { id: "gemini-9-argon" },
      ties: 0,
    });
    // A newer version clears the count of the old tie.
    expect(resolveFamilyDetail(family("gemini"), p([...tiers, "gemini-9.1-pro"], "cursor"))).toMatchObject({
      model: { id: "gemini-9.1-pro" },
      ties: 0,
    });
  });

  it("matches Kiro's dotted ids and Bedrock-style prefixes", () => {
    expect(resolveFamily(family("claude-opus"), p(["claude-opus-5.5", "claude-opus-5"], "kiro"))?.id).toBe(
      "claude-opus-5.5",
    );
    expect(resolveFamily(family("claude-opus"), p(["us.anthropic.claude-opus-4-6-v1"], "acpRegistry"))?.id).toBe(
      "us.anthropic.claude-opus-4-6-v1",
    );
  });
});
