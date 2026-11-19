import { describe, expect, it } from "vitest";
import { mergeCapabilities } from "../src/capabilities.js";
import { recommendModel, type Recommendation } from "../src/recommend.js";
import { NoneUsageSource } from "../src/usage.js";
import { connectServer, defaultPolicy, driverFixture, driverFixtureRaw } from "./helpers.js";

// T3 answers orchestrator_capabilities with `search` by listing every provider:
// the ones the search does not select come back with `models: []` and no
// `omittedModels`. search-mixed-cursor-opus.json is that output for
// `search: "cursor opus"` on the providers of mixed.json.
const full = () => driverFixtureRaw("mixed");
const cursorOpus = () => driverFixtureRaw("search-mixed-cursor-opus");
const opencodeOpus = () => ({
  providers: [
    {
      providerInstanceId: "opencode",
      driverKind: "opencode",
      models: [{ id: "openrouter/anthropic/claude-opus-9.2" }],
      canRunChildTask: true,
    },
  ],
});

const policy = defaultPolicy();
const rec = (capabilities: unknown) => recommendModel({ task: "x", taskType: "code", capabilities }, policy, new NoneUsageSource());
/** Provider instance ids that have an omitted-models warning. */
const warned = (r: Pick<Recommendation, "warnings">) => r.warnings.map((w) => w.slice(0, w.indexOf(":")));
const ids = (r: Pick<Recommendation, "candidates">) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);

describe("merging a search output", () => {
  it("keeps the warning of every provider the search did not list", async () => {
    expect(warned(await rec(full()))).toEqual(["cursor", "opencode", "pi"]);
    const after = await rec([full(), cursorOpus()]);
    expect(warned(after)).toEqual(["opencode", "pi"]);
    expect(after.warnings[0]).toMatch(/^opencode: orchestrator_capabilities left out 67 models/);
  });

  it("keeps omittedModels and every model of the providers the search left empty", () => {
    const merged = mergeCapabilities([driverFixture("mixed"), driverFixture("search-mixed-cursor-opus")]);
    const byId = (id: string) => merged.providers.find((p) => p.providerInstanceId === id)!;
    // cursor: 2 of the 3 opus models were not in the short list.
    expect(byId("cursor")).toMatchObject({ omittedModels: 38, mergedOutputs: 2 });
    expect(byId("cursor").models.map((m) => m.id)).toEqual(expect.arrayContaining(["claude-opus-9-2", "claude-opus-8-7"]));
    for (const id of ["codex", "opencode", "kiro", "pi"]) {
      const before = driverFixture("mixed").providers.find((p) => p.providerInstanceId === id)!;
      expect(byId(id).models, id).toEqual(before.models);
      expect(byId(id).omittedModels, id).toBe(before.omittedModels);
      expect(byId(id).mergedOutputs, id).toBeUndefined();
    }
  });

  it("lets the model found by the search win and keeps the rest of the ranking", async () => {
    expect(ids(await rec(full()))).toEqual(["codex/gpt-9.1-sol", "cursor/claude-opus-9-1", "opencode/openrouter/anthropic/claude-opus-9.1"]);
    expect(ids(await rec([full(), cursorOpus()]))).toEqual([
      "codex/gpt-9.1-sol",
      "cursor/claude-opus-9-2",
      "opencode/openrouter/anthropic/claude-opus-9.1",
    ]);
  });

  it("drops a provider's warning once a search that lists its models is merged", async () => {
    const r = await rec([full(), cursorOpus(), opencodeOpus()]);
    expect(warned(r)).toEqual(["pi"]);
    expect(ids(r)).toContain("opencode/openrouter/anthropic/claude-opus-9.2");
  });

  it("does the same through the server cache with mergeCapabilities: true", async () => {
    const { client } = await connectServer();
    const call = async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      return res.structuredContent as Recommendation & { capabilitiesFrom: string };
    };
    expect(warned(await call({ capabilities: full() }))).toEqual(["cursor", "opencode", "pi"]);
    const merged = await call({ capabilities: cursorOpus(), mergeCapabilities: true });
    expect(merged.capabilitiesFrom).toBe("merged");
    expect(warned(merged)).toEqual(["opencode", "pi"]);
    // The cache holds the merge, warnings included.
    const cached = await call({});
    expect(cached.capabilitiesFrom).toBe("cache");
    expect(warned(cached)).toEqual(["opencode", "pi"]);
    expect(ids(cached)[1]).toBe("cursor/claude-opus-9-2");
    // A second search, for opencode, clears its warning too.
    expect(warned(await call({ capabilities: opencodeOpus(), mergeCapabilities: true }))).toEqual(["pi"]);
  });
});
