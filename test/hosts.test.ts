import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCapabilitiesInput } from "../src/capabilities.js";
import { DEFAULT_HOST, HOSTS, hostContext } from "../src/hosts/index.js";
import { t3 } from "../src/hosts/t3.js";
import { DEFAULT_RECOMMEND_TEXT, type Recommendation } from "../src/recommend.js";
import { INSTRUCTIONS_SNIPPET } from "../src/snippet.js";
import { fake, fakePayload } from "./fakeHost.js";
import { connectServer, defaultPolicy, driverFixtureRaw, resultText, tempDir } from "./helpers.js";

type Result = Recommendation & { capabilitiesFrom: string };

const T0 = new Date("2026-11-21T09:00:00Z");
const ctx = hostContext(tempDir(), T0, defaultPolicy());

describe("the host registry", () => {
  it("knows T3 Code, the default host, herdr and Orca", () => {
    expect(HOSTS.map((h) => h.id)).toEqual(["t3", "herdr", "orca"]);
    expect(DEFAULT_HOST).toBe(t3);
  });

  it("every host has its own id, cache file and snippet", () => {
    const all = [...HOSTS, fake];
    for (const key of ["id", "cacheFile", "snippet"] as const) {
      expect(new Set(all.map((h) => h[key])).size, key).toBe(all.length);
    }
  });
});

describe("the context an adapter gets", () => {
  it("reads the agent catalog from the data directory when the adapter first reads it, once per call", () => {
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  goose: { models: [default] }\n");
    const context = hostContext(home, T0, defaultPolicy());
    const first = context.catalog;
    expect(first.sources).toEqual([expect.stringMatching(/agents\.yaml$/), join(home, "catalog.yaml")]);
    expect(Object.keys(first.catalog.agents)).toContain("goose");
    writeFileSync(join(home, "catalog.yaml"), "agents: { goose: null }\n");
    expect(context.catalog).toBe(first);
    // A new call reads the files again.
    expect(Object.keys(hostContext(home, T0, defaultPolicy()).catalog.catalog.agents)).not.toContain("goose");
  });

  it("checks the catalog against the policy in force, and names the user's file when it is invalid", () => {
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  claude: { models: [{ id: opus, family: claude-opux }] }\n");
    expect(hostContext(home, T0, defaultPolicy()).catalog.warnings).toEqual([
      expect.stringMatching(/"claude-opux" is not a policy family, so "opus" is matched by its id alone/),
    ]);
    writeFileSync(join(home, "catalog.yaml"), 'agents:\n  claude: { models: ["opus; rm -rf"] }\n');
    expect(() => hostContext(home, T0, defaultPolicy()).catalog).toThrow(
      `Invalid agent catalog (${join(home, "catalog.yaml")}, on top of the built-in catalog)`,
    );
  });

  it("never reads the catalog for T3 Code: an invalid catalog.yaml does not fail its calls", async () => {
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents: [not, a, mapping]\n");
    const { client } = await connectServer(home);
    const res = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: driverFixtureRaw("mixed") },
    });
    expect(res.isError, resultText(res)).toBeFalsy();
  });
});

describe("the T3 Code adapter", () => {
  const full = driverFixtureRaw("mixed");
  const search = driverFixtureRaw("search-mixed-cursor-opus");

  it("recognises orchestrator_capabilities output in every form the server accepts", () => {
    const forms = [
      full,
      JSON.stringify(full),
      full.providers,
      [full, search],
      JSON.stringify([full, search]),
      [JSON.stringify(full), JSON.stringify(search)],
      [],
    ];
    for (const payload of forms) expect(t3.detect(payload)).toBe(true);
    // A list with one provider or output is T3's, so the parser names the item that is wrong.
    expect(t3.detect([(full.providers as unknown[])[0], {}])).toBe(true);
    expect(t3.detect([full, "{bad"])).toBe(true);
    // A list of plain strings is no form of T3's output (each provider is an object): herdr's program names. Nor is
    // a list with no provider or output in it, nor a failed command's output.
    const others = [
      fakePayload([]),
      {},
      "{bad",
      "plain text",
      42,
      null,
      undefined,
      ["claude", "codex"],
      '["claude"]',
      [{}],
      [{ id: "claude" }],
      [42, null],
      { ok: false, error: { code: "internal" } },
    ];
    for (const payload of others) expect(t3.detect(payload), JSON.stringify(payload)).toBe(false);
  });

  it("builds the catalog with parseCapabilitiesInput, with no notes of its own", () => {
    expect(t3.catalog({ capabilities: [full, search] }, ctx)).toEqual({
      ...parseCapabilitiesInput([full, search]),
      session: "thread:fixture-orchestrator",
      notes: [],
    });
    // No thread (null outside one, or an old output): no session.
    expect(t3.catalog({ capabilities: { ...full, parentThreadId: null } }, ctx)).not.toHaveProperty("session");
    expect(t3.catalog({ capabilities: full.providers }, ctx)).not.toHaveProperty("session");
    expect(t3.catalog({ capabilities: full }, ctx).outputs).toBe(0);
    expect(() => t3.catalog({ capabilities: "{bad" }, ctx)).toThrow(/^capabilities is a string but not valid JSON/);
  });

  it("drops a policyFamily from T3's models, so the agent catalog's family hook never applies to them", () => {
    const tagged = structuredClone(full) as { providers: { models: Record<string, unknown>[] }[] };
    for (const provider of tagged.providers) for (const model of provider.models) model.policyFamily = "gpt";
    const { capabilities } = t3.catalog({ capabilities: tagged }, ctx);
    expect(capabilities).toEqual(t3.catalog({ capabilities: full }, ctx).capabilities);
    expect(JSON.stringify(capabilities)).not.toContain("policyFamily");
  });

  it("keeps the file, the snippet and the texts of 0.1", () => {
    expect(t3.legacyCacheFile).toBe("capabilities-cache.json");
    expect(t3.cacheFile).toBe("capabilities-cache.t3.json");
    expect(t3.snippet).toBe(INSTRUCTIONS_SNIPPET);
    expect(t3.merges).toBe(true);
    expect(t3.text).toMatchObject(DEFAULT_RECOMMEND_TEXT);
    expect(t3.text.noCatalog).toMatch(/^No capabilities yet: call orchestrator_capabilities/);
  });
});

describe("the server with another host's adapter", () => {
  // The fake host as the only one: what the server says about the catalog comes from the adapter.
  const connect = (home = tempDir(), at = T0) => connectServer(home, { hosts: [fake], now: () => at });
  const recommend = async (client: Awaited<ReturnType<typeof connect>>["client"], args: Record<string, unknown>) =>
    client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
  const data = (res: object) => {
    expect((res as { isError?: boolean }).isError, resultText(res)).toBeFalsy();
    return (res as { structuredContent: Result }).structuredContent;
  };
  const agents = fakePayload(
    [
      { id: "claude", driver: "claudeAgent", models: ["claude-opus-9-1", "claude-sonnet-9-1"] },
      { id: "tool", driver: "toolCli", models: ["alpha", "beta"] },
    ],
    { agent: "claude", model: "claude-opus-9-1" },
  );

  it("builds the catalog with the adapter, adds its notes and ignores mergeCapabilities", async () => {
    const { client } = await connect();
    expect(resultText(await recommend(client, {}))).toBe(fake.text.noCatalog);
    const first = data(await recommend(client, { capabilities: agents, mergeCapabilities: true }));
    expect(first.capabilitiesFrom).toBe("call");
    expect(first.warnings.slice(0, 2)).toEqual([
      "Fake Host: 2 agents",
      "mergeCapabilities is ignored: Fake Host sends its whole catalog in one output.",
    ]);
    expect(first.candidates[0]).toMatchObject({
      providerInstanceId: "claude",
      model: "claude-opus-9-1",
      options: [{ id: "effort", value: "high" }],
      sameAsOrchestrator: true,
    });
    const generic = first.candidates.find((c) => c.providerInstanceId === "tool");
    expect(generic?.reason).toMatch(/: alpha is the first model Fake Host declares on tool, effort high$/);
    // Kept, as a full catalog: a lone output of a host that does not merge is never a search.
    expect(data(await recommend(client, {})).capabilitiesFrom).toBe("cache");
  });

  it("saves the capabilities in the adapter's cache file and names its command after a restart", async () => {
    const home = tempDir();
    data(await recommend((await connect(home)).client, { capabilities: agents }));
    expect(existsSync(join(home, "capabilities-cache.fake.json"))).toBe(true);
    expect(existsSync(join(home, "capabilities-cache.json"))).toBe(false);
    const after = data(await recommend((await connect(home, new Date(T0.getTime() + 3_600_000))).client, {}));
    expect(after.capabilitiesFrom).toBe("disk-cache");
    expect(after.warnings[0]).toBe(
      "Capabilities from the disk cache (the server restarted): received 1 h ago by an orchestrator on claude / " +
        "claude-opus-9-1. If that is not you, or a child cannot start or its model id is rejected, run fake-agents " +
        "and pass its output as capabilities.",
    );
  });

  it("passes the adapter's texts to the engine", async () => {
    const { client } = await connect();
    expect(resultText(await recommend(client, { capabilities: fakePayload([]) }))).toBe(fake.text.noProviders);
    expect(resultText(await recommend(client, { capabilities: fakePayload([{ id: "a", ready: false }]) }))).toBe(
      "No provider instance can run a child task (a: not signed in). Install an agent in Fake Host, or remove it " +
        "from excludeProviders.",
    );
    const tie = data(
      await recommend(client, {
        taskType: "review",
        capabilities: fakePayload([{ id: "gem", driver: "geminiCli", models: ["gemini-4-neon", "gemini-4-argon"] }]),
      }),
    );
    expect(tie.candidates[0]?.reason).toMatch(/same version as 1 other, Fake Host declares this one first/);
  });

  it("set_subscription names the host's catalog when the id is not in it", async () => {
    const { client } = await connect();
    data(await recommend(client, { capabilities: agents }));
    const res = await client.callTool({
      name: "set_subscription",
      arguments: { providerInstanceId: "nobody", plan: "Free", quota: "tight" },
    });
    expect((res.structuredContent as { warnings: string[] }).warnings).toEqual([
      "nobody is not in the last fake-agents output; check the providerInstanceId (saved anyway).",
    ]);
  });
});
