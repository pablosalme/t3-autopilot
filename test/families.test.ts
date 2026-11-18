import { describe, expect, it } from "vitest";
import { compareVersions, resolveFamily, versionKey } from "../src/families.js";
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
