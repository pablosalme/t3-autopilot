import { describe, expect, it } from "vitest";
import type { Provider } from "../src/capabilities.js";
import { resolveFamily } from "../src/families.js";
import type { Recommendation } from "../src/recommend.js";
import { connectServer, defaultPolicy, driverFixtureRaw } from "./helpers.js";

// Providers rename model tiers (Antigravity's named Gemini tiers, Codex's
// named GPT tiers) without changing the family. Families are regexes over the
// id, so the new name is picked up with the bundled policy unchanged.
const policy = defaultPolicy();
const family = (name: string) => policy.families[name]!;
const provider = (driverKind: string, ids: string[]): Provider => ({
  providerInstanceId: driverKind,
  driverKind,
  models: ids.map((id) => ({ id })),
  canRunChildTask: true,
});

/** A per-driver fixture with model ids renamed, as T3 would list them after the provider renamed them. */
function renamed(driver: string, renames: Record<string, string>): Record<string, unknown> {
  const raw = driverFixtureRaw(driver) as { providers: { models: { id: string; label?: string }[] }[] };
  for (const p of raw.providers) {
    for (const m of p.models) {
      if (Object.hasOwn(renames, m.id)) {
        m.id = renames[m.id]!;
        delete m.label;
      }
    }
  }
  return raw;
}

describe("models renamed by the provider", () => {
  it("no family pattern of the bundled policy names a flagship tier", () => {
    const patterns = Object.values(policy.families).flatMap((f) => [...Object.values(f.match), f.exclude ?? ""]);
    for (const tier of ["carbon", "neon", "astra", "sol", "vega", "dawn"]) {
      expect(patterns.filter((p) => p.includes(tier)), tier).toEqual([]);
    }
  });

  it("gemini-4-carbon replaced by gemini-4-neon resolves to the new id", () => {
    const before = provider("antigravity", ["antigravity-default", "gemini-4-carbon", "gemini-3.8-flash-high", "gemini-3.1-pro-low"]);
    const after = provider("antigravity", ["antigravity-default", "gemini-4-neon", "gemini-3.8-flash-high", "gemini-3.1-pro-low"]);
    expect(resolveFamily(family("gemini"), before)?.id).toBe("gemini-4-carbon");
    expect(resolveFamily(family("gemini"), after)?.id).toBe("gemini-4-neon");
    // The flash family is unaffected by the rename.
    expect(resolveFamily(family("gemini-flash"), after)?.id).toBe("gemini-3.8-flash-high");
  });

  it("a rename that also bumps the version wins over the old name", () => {
    expect(resolveFamily(family("gemini"), provider("antigravity", ["gemini-4-carbon", "gemini-4.1-neon"]))?.id).toBe("gemini-4.1-neon");
    expect(resolveFamily(family("gpt"), provider("codex", ["gpt-9.1-sol", "gpt-9.2-vega"]))?.id).toBe("gpt-9.2-vega");
    expect(resolveFamily(family("muse"), provider("muse", ["muse-spark-3.1", "muse-dawn-3.2"]))?.id).toBe("muse-dawn-3.2");
  });

  it("while both names are listed with the same version, T3's order (the user's preference) decides", () => {
    expect(resolveFamily(family("gemini"), provider("antigravity", ["gemini-4-neon", "gemini-4-carbon"]))?.id).toBe("gemini-4-neon");
    expect(resolveFamily(family("gemini"), provider("antigravity", ["gemini-4-carbon", "gemini-4-neon"]))?.id).toBe("gemini-4-carbon");
  });

  it("between two recommend_model calls, a fresh orchestrator_capabilities output replaces the old name", async () => {
    const { client } = await connectServer();
    const call = async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      return res.structuredContent as Recommendation & { capabilitiesFrom: string };
    };
    const first = await call({ capabilities: driverFixtureRaw("antigravity") });
    expect(first.candidates[0]).toMatchObject({ providerInstanceId: "antigravity", model: "gemini-7-carbon" });

    const second = await call({ capabilities: renamed("antigravity", { "gemini-7-carbon": "gemini-7-neon" }) });
    expect(second.capabilitiesFrom).toBe("call");
    expect(second.candidates[0]).toMatchObject({ providerInstanceId: "antigravity", model: "gemini-7-neon" });
    expect(second.candidates.some((c) => c.model === "gemini-7-carbon")).toBe(false);

    const cached = await call({});
    expect(cached.capabilitiesFrom).toBe("cache");
    expect(cached.candidates[0]!.model).toBe("gemini-7-neon");
  });

  it("Codex's flagship tier renamed: code and review pick the new id, with the same effort option", async () => {
    const { client } = await connectServer();
    const capabilities = renamed("codex", { "gpt-9.1-sol": "gpt-9.1-vega" });
    for (const taskType of ["code", "review"]) {
      const res = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType, capabilities } });
      const data = res.structuredContent as Recommendation;
      expect(data.candidates[0], taskType).toMatchObject({
        providerInstanceId: "codex",
        model: "gpt-9.1-vega",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
    }
  });
});
