import { describe, expect, it } from "vitest";
import { mergeCapabilities } from "../src/capabilities.js";
import { type Recommendation, recommendModel } from "../src/recommend.js";
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

/**
 * A `search: "cursor gemini"` output: T3 lists at most 8 matches, in the user's
 * order (not by version), and counts the rest in `omittedModels`.
 */
const cursorSearch = (models: string[], omittedModels?: number) => ({
  providers: [
    { providerInstanceId: "codex", driverKind: "codex", models: [], canRunChildTask: true },
    {
      providerInstanceId: "cursor",
      driverKind: "cursor",
      models: models.map((id) => ({ id })),
      ...(omittedModels === undefined ? {} : { omittedModels }),
      canRunChildTask: true,
    },
  ],
});
const EIGHT_GEMINI = [
  "gemini-9-argon",
  "gemini-9-carbon",
  "gemini-9-hydrogen",
  "gemini-8.5-pro",
  "gemini-8-pro",
  "gemini-9-flash",
  "gemini-8.5-flash",
  "gemini-8-flash-lite",
];

const policy = defaultPolicy();
const rec = (capabilities: unknown) =>
  recommendModel({ task: "x", taskType: "code", capabilities }, policy, new NoneUsageSource());
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
    expect(byId("cursor").models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["claude-opus-9-2", "claude-opus-8-7"]),
    );
    for (const id of ["codex", "opencode", "kiro", "pi"]) {
      const before = driverFixture("mixed").providers.find((p) => p.providerInstanceId === id)!;
      expect(byId(id).models, id).toEqual(before.models);
      expect(byId(id).omittedModels, id).toBe(before.omittedModels);
      expect(byId(id).mergedOutputs, id).toBeUndefined();
    }
  });

  it("lets the model found by the search win and keeps the rest of the ranking", async () => {
    expect(ids(await rec(full()))).toEqual([
      "codex/gpt-9.1-sol",
      "cursor/claude-opus-9-1",
      "opencode/openrouter/anthropic/claude-opus-9.1",
    ]);
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
      const res = await client.callTool({
        name: "recommend_model",
        arguments: { task: "x", taskType: "code", ...args },
      });
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
    // A truncated search brings cursor's warning back: its latest list is cut again.
    const truncated = await call({ capabilities: cursorSearch(EIGHT_GEMINI, 12), mergeCapabilities: true });
    expect(warned(truncated)).toEqual(["cursor", "pi"]);
  });

  it("says so when there is nothing to merge into (first call, or the server restarted)", async () => {
    const { client } = await connectServer();
    const res = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: cursorOpus(), mergeCapabilities: true },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as Recommendation & { capabilitiesFrom: string };
    expect(data.capabilitiesFrom).toBe("call");
    expect(data.warnings[0]).toMatch(/^mergeCapabilities: there were no earlier capabilities to merge into/);
    expect(ids(data)[0]).toBe("cursor/claude-opus-9-2");
  });
});

describe("a truncated search (more than 8 matches)", () => {
  const design = (capabilities: unknown) =>
    recommendModel({ task: "x", taskType: "design", capabilities }, policy, new NoneUsageSource());

  it("keeps the provider's warning and suggests a narrower search", async () => {
    const r = await design([driverFixtureRaw("cursor"), cursorSearch(EIGHT_GEMINI, 12)]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /^cursor: the last orchestrator_capabilities output for it listed 8 models and left out 12 more/,
    );
    expect(r.warnings[0]).toContain('search "cursor gemini-9", "cursor gemini-10"');
    expect(r.warnings[0]).toContain("mergeCapabilities: true");
  });

  it("does not call the pick from a truncated list the latest", async () => {
    const r = await design([driverFixtureRaw("cursor"), cursorSearch(EIGHT_GEMINI, 12)]);
    const gemini = r.candidates.find((c) => c.model.startsWith("gemini-"))!;
    expect(gemini.model).toBe("gemini-9-argon");
    expect(gemini.reason).not.toMatch(/latest/);
    expect(gemini.reason).toMatch(/newest listed gemini on cursor is gemini-9-argon/);
    expect(gemini.reason).toMatch(/12 models left out of the list/);
  });

  it("drops the warning once a narrower search lists every match", async () => {
    const narrower = cursorSearch(["gemini-9-neon", "gemini-9-argon", "gemini-9-carbon", "gemini-9-hydrogen"]);
    const r = await design([driverFixtureRaw("cursor"), cursorSearch(EIGHT_GEMINI, 12), narrower]);
    expect(r.warnings).toEqual([]);
    expect(r.candidates.map((c) => c.reason).join("\n")).not.toMatch(/newest listed|left out/);
  });

  it("also says newest listed on the full output's short list", async () => {
    const r = await design(driverFixtureRaw("cursor"));
    const gemini = r.candidates.find((c) => c.model.startsWith("gemini-"))!;
    expect(gemini.reason).toMatch(/newest listed gemini on cursor is gemini-7-pro/);
  });

  it("gives a generic hint when the search listed no model of a family the task uses", async () => {
    const r = await design([driverFixtureRaw("cursor"), cursorSearch(["composer-9", "composer-8"], 3)]);
    expect(r.warnings[0]).toMatch(/listed 2 models and left out 3 more/);
    expect(r.warnings[0]).toMatch(/Narrow the search with a more specific term/);
  });
});

describe("merging, edge cases", () => {
  it("a provider that cannot run child tasks in a later output becomes ineligible", async () => {
    const later = driverFixtureRaw("search-mixed-cursor-opus") as { providers: Record<string, unknown>[] };
    const opencode = later.providers.find((p) => p.providerInstanceId === "opencode")!;
    Object.assign(opencode, { canRunChildTask: false, constraints: ["Provider is not authenticated."] });
    const r = await rec([full(), later]);
    expect(ids(r).some((id) => id.startsWith("opencode/"))).toBe(false);
    expect(r.skipped).toContain("opencode: Provider is not authenticated.");
  });

  it("names the element of a list that is not valid JSON", async () => {
    await expect(rec([full(), "{not json"])).rejects.toThrow(/^capabilities\[1\] is a string but not valid JSON/);
  });
});
