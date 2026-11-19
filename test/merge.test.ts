import { describe, expect, it } from "vitest";
import { mergeCapabilities, parseCapabilities } from "../src/capabilities.js";
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
    expect(gemini.reason).toMatch(/: gemini on cursor is gemini-9-argon/);
    expect(gemini.reason).toMatch(/same version as 2 others, T3 lists this one first; 12 models left out of the list/);
    // Without a tie, the truncated list still rules out "latest".
    const one = await design([driverFixtureRaw("cursor"), cursorSearch(["gemini-9-argon", "gemini-8-pro"], 12)]);
    const only = one.candidates.find((c) => c.model.startsWith("gemini-"))!;
    expect(only.reason).toMatch(/newest listed gemini on cursor is gemini-9-argon/);
  });

  it("drops the warning once a narrower search lists every match, and keeps T3's order for ties", async () => {
    const narrower = cursorSearch(["gemini-9-neon", "gemini-9-argon", "gemini-9-carbon", "gemini-9-hydrogen"]);
    const r = await design([driverFixtureRaw("cursor"), cursorSearch(EIGHT_GEMINI, 12), narrower]);
    expect(r.warnings).toEqual([]);
    expect(r.candidates.map((c) => c.reason).join("\n")).not.toMatch(/newest listed|left out/);
    // T3 lists neon before argon, so the merge puts it there and neon wins the tie.
    const gemini = r.candidates.find((c) => c.model.startsWith("gemini-"))!;
    expect(gemini.model).toBe("gemini-9-neon");
    expect(gemini.reason).toMatch(
      /: gemini on cursor is gemini-9-neon \(same version as 3 others, T3 lists this one first/,
    );
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

describe("merging keeps T3's order", () => {
  const ordered = (outputs: unknown[]) =>
    mergeCapabilities(outputs.map((o) => parseCapabilities(o)))
      .providers.find((p) => p.providerInstanceId === "cursor")!
      .models.map((m) => m.id);

  it("puts a new model after the one listed before it, or before the next known one", () => {
    expect(ordered([cursorSearch(["a", "b", "c"]), cursorSearch(["x", "b", "y", "z", "c", "w"])])).toEqual([
      "a",
      "x",
      "b",
      "y",
      "z",
      "c",
      "w",
    ]);
    expect(ordered([cursorSearch(["a"]), cursorSearch(["p", "q"])])).toEqual(["a", "p", "q"]);
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

// A later output is newer than the ones before it: what both say, the later one decides.
describe("merging: the later output is the newer one", () => {
  const EFFORT = { id: "effort", values: ["low", "medium", "high", "xhigh", "max", "ultrathink"], default: "medium" };
  /** One Claude provider; `options` false lists the models bare, as a caller that trims the output would. */
  const claude = (models: string[], options: boolean, extra: Record<string, unknown> = {}) => ({
    inheritedProviderInstanceId: "claudeAgent",
    inheritedModel: "claude-opus-9-2",
    providers: [
      {
        providerInstanceId: "claudeAgent",
        driverKind: "claudeAgent",
        models: models.map((id) => (options ? { id, label: id, options: [EFFORT] } : { id })),
        canRunChildTask: true,
        ...extra,
      },
    ],
  });
  const plan = (capabilities: unknown) =>
    recommendModel({ task: "x", taskType: "plan", capabilities }, policy, new NoneUsageSource());
  const model = (caps: ReturnType<typeof mergeCapabilities>, id: string) =>
    caps.providers[0]!.models.find((m) => m.id === id)!;

  it("takes the options of a model both outputs list from the later one", async () => {
    const bare = claude(["claude-opus-9-2", "claude-fable-8-3"], false);
    const search = claude(["claude-fable-8-3", "claude-fable-8-2"], true);
    const before = (await plan(bare)).candidates.find((c) => c.model === "claude-fable-8-3")!;
    expect(before.reason).toMatch(/model has no effort option/);

    const merged = mergeCapabilities([parseCapabilities(bare), parseCapabilities(search)]);
    expect(merged.providers[0]!.models.map((m) => m.id)).toEqual([
      "claude-opus-9-2",
      "claude-fable-8-3",
      "claude-fable-8-2",
    ]);
    expect(model(merged, "claude-fable-8-3")).toEqual({
      id: "claude-fable-8-3",
      label: "claude-fable-8-3",
      options: [EFFORT],
    });
    expect(model(merged, "claude-opus-9-2").options).toBeUndefined();
    const after = (await plan([bare, search])).candidates.find((c) => c.model === "claude-fable-8-3")!;
    expect(after.options).toEqual([{ id: "effort", value: "high" }]);
    expect(after.reason).not.toMatch(/no effort option/);
  });

  it("keeps the options it knows when a later output lists the model without them", () => {
    const merged = mergeCapabilities([
      parseCapabilities(claude(["claude-fable-8-3"], true)),
      parseCapabilities(claude(["claude-fable-8-3"], false)),
    ]);
    expect(model(merged, "claude-fable-8-3").options).toEqual([EFFORT]);
    // An explicit empty list says the model has none now.
    const none = claude(["claude-fable-8-3"], false);
    Object.assign(none.providers[0]!.models[0]!, { options: [] });
    const cleared = mergeCapabilities([parseCapabilities(claude(["claude-fable-8-3"], true)), parseCapabilities(none)]);
    expect(model(cleared, "claude-fable-8-3").options).toEqual([]);
  });

  it("takes the orchestrator from the latest output that names one", async () => {
    const mine = { ...claude(["claude-fable-8-3"], true), inheritedModel: "claude-fable-8-3", inheritedOptions: [] };
    const merged = mergeCapabilities([
      parseCapabilities(claude(["claude-opus-9-2", "claude-fable-8-3"], true)),
      parseCapabilities(mine),
      // A bare providers array names no orchestrator.
      parseCapabilities(claude(["claude-fable-8-3"], true).providers),
    ]);
    expect(merged).toMatchObject({
      inheritedProviderInstanceId: "claudeAgent",
      inheritedModel: "claude-fable-8-3",
      inheritedOptions: [],
    });
    const r = await plan([claude(["claude-opus-9-2", "claude-fable-8-3"], true), mine]);
    expect(Object.fromEntries(r.candidates.map((c) => [c.model, c.sameAsOrchestrator]))).toEqual({
      "claude-opus-9-2": false,
      "claude-fable-8-3": true,
    });
  });

  it("lets a provider that can run child tasks again be recommended again", async () => {
    const off = claude(["claude-opus-9-2"], true, {
      canRunChildTask: false,
      canRunCrossProviderChildTask: false,
      constraints: ["Provider is not authenticated."],
    });
    const on = claude(["claude-fable-8-3"], true, { canRunCrossProviderChildTask: true, constraints: [] });
    await expect(plan(off)).rejects.toThrow(/No provider instance can run a child task/);
    const merged = mergeCapabilities([parseCapabilities(off), parseCapabilities(on)]);
    expect(merged.providers[0]).toMatchObject({
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    });
    const r = await plan([off, on]);
    expect(ids(r)).toEqual(["claudeAgent/claude-opus-9-2", "claudeAgent/claude-fable-8-3"]);
    expect(r.skipped).toEqual([]);
  });

  it("keeps what the last search said when a merged list is merged again", async () => {
    // [full, search] passed with mergeCapabilities: true into capabilities the server already keeps.
    const list = mergeCapabilities([driverFixture("mixed"), driverFixture("search-mixed-cursor-opus")]);
    const again = mergeCapabilities([driverFixture("mixed"), list]);
    const cursor = again.providers.find((p) => p.providerInstanceId === "cursor")!;
    expect(cursor).toMatchObject({ omittedModels: 38, mergedOutputs: 3 });
    expect(cursor.lastOutput).toEqual({
      models: ["claude-opus-9-2", "claude-opus-9-1", "claude-opus-8-7"],
      omittedModels: 0,
    });
    expect(warned(await rec(again))).toEqual(["opencode", "pi"]);
  });
});
