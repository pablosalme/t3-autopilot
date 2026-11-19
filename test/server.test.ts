import { describe, expect, it } from "vitest";
import { connectServer, driverFixtureRaw, fixture } from "./helpers.js";

const connect = async () => (await connectServer()).client;

describe("MCP server", () => {
  it("lists the five tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_stats",
      "log_delegation",
      "log_outcome",
      "mark_unavailable",
      "recommend_model",
    ]);
  });

  it("recommends, logs and reports stats end to end", async () => {
    const client = await connect();
    const rec = await client.callTool({
      name: "recommend_model",
      arguments: { task: "Implement the export endpoint", capabilities: fixture() },
    });
    expect(rec.isError).toBeFalsy();
    const data = rec.structuredContent as {
      taskType: string;
      candidates: { providerInstanceId: string; model: string }[];
    };
    expect(data.candidates[0]).toMatchObject({ providerInstanceId: "claudeAgent", model: "claude-opus-7-1" });

    const out = await client.callTool({
      name: "log_outcome",
      arguments: {
        taskType: data.taskType,
        providerInstanceId: "claudeAgent",
        model: "claude-opus-7-1",
        outcome: "success",
      },
    });
    expect(out.isError).toBeFalsy();

    const stats = await client.callTool({ name: "get_stats", arguments: {} });
    expect((stats.structuredContent as { total: { success: number } }).total.success).toBe(1);
  });

  it("returns tool errors instead of throwing", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "recommend_model", arguments: { task: "x", capabilities: "{bad" } });
    expect(res.isError).toBe(true);
  });

  it("keeps the last capabilities so later calls can omit them (#8)", async () => {
    const client = await connect();
    const first = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code" } });
    expect(first.isError).toBe(true);
    expect(JSON.stringify(first.content)).toMatch(/No capabilities yet/);

    const withCaps = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: fixture() },
    });
    expect((withCaps.structuredContent as { capabilitiesFrom: string }).capabilitiesFrom).toBe("call");
    const cached = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code" } });
    expect(cached.isError).toBeFalsy();
    const data = cached.structuredContent as { capabilitiesFrom: string; candidates: { providerInstanceId: string }[] };
    expect(data.capabilitiesFrom).toBe("cache");
    expect(data.candidates[0]!.providerInstanceId).toBe("claudeAgent");
  });

  it("merges a search output into the cached capabilities", async () => {
    const client = await connect();
    await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "review", capabilities: driverFixtureRaw("cursor") },
    });
    const merged = await client.callTool({
      name: "recommend_model",
      arguments: {
        task: "x",
        taskType: "review",
        capabilities: driverFixtureRaw("search-cursor-gemini"),
        mergeCapabilities: true,
      },
    });
    const data = merged.structuredContent as { capabilitiesFrom: string; candidates: { model: string }[] };
    expect(data.capabilitiesFrom).toBe("merged");
    expect(data.candidates.map((c) => c.model)).toContain("gemini-8-pro");
    // The merge is kept for the next call.
    const again = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "review" } });
    expect((again.structuredContent as typeof data).candidates.map((c) => c.model)).toContain("gemini-8-pro");
  });

  it("accepts a bare providers array (#10)", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: fixture().providers },
    });
    expect(res.isError).toBeFalsy();
  });

  it("rejects prototype keys as taskType everywhere (#6)", async () => {
    const client = await connect();
    for (const taskType of ["constructor", "__proto__"]) {
      const rec = await client.callTool({
        name: "recommend_model",
        arguments: { task: "x", taskType, capabilities: fixture() },
      });
      expect(rec.isError).toBe(true);
      expect(JSON.stringify(rec.content)).toMatch(/Unknown taskType/);
      const out = await client.callTool({
        name: "log_outcome",
        arguments: { taskType, providerInstanceId: "a", model: "m", outcome: "success" },
      });
      expect(out.isError).toBe(true);
      const del = await client.callTool({
        name: "log_delegation",
        arguments: { taskType, providerInstanceId: "a", model: "m" },
      });
      expect(del.isError).toBe(true);
    }
    const stats = await client.callTool({ name: "get_stats", arguments: { taskType: "constructor" } });
    expect(stats.isError).toBeFalsy();
    expect((stats.structuredContent as { stats: unknown }).stats).toBeNull();
  });

  it("validates input: bad enums, missing fields, bad dates", async () => {
    const client = await connect();
    const bad = async (name: string, args: Record<string, unknown>) => {
      const res = await client
        .callTool({ name, arguments: args })
        .catch((e: unknown) => ({ isError: true, thrown: e }));
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    };
    await bad("recommend_model", { task: "x", size: "huge", capabilities: fixture() });
    await bad("recommend_model", { task: "", capabilities: fixture() });
    await bad("recommend_model", { capabilities: fixture() });
    await bad("log_outcome", { outcome: "maybe", taskType: "code", providerInstanceId: "a", model: "m" });
    await bad("log_outcome", { outcome: "success" });
    await bad("get_stats", { since: "not a date" });
  });

  it("rejects an empty provider or model instead of logging a record the stats cannot count", async () => {
    const client = await connect();
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }).catch((e: unknown) => ({ isError: true, thrown: e }));
    const rejected = [
      await call("log_outcome", { taskType: "code", providerInstanceId: "codex", model: "", outcome: "success" }),
      await call("log_outcome", { taskType: "code", providerInstanceId: "", model: "m", outcome: "success" }),
      await call("log_delegation", { taskType: "code", providerInstanceId: "", model: "m" }),
      await call("log_delegation", { taskType: "code", providerInstanceId: "codex", model: "" }),
    ];
    expect(rejected.map((r) => r.isError)).toEqual([true, true, true, true]);
    const stats = await client.callTool({ name: "get_stats", arguments: {} });
    expect((stats.structuredContent as { total: { delegations: number } }).total.delegations).toBe(0);
  });

  it("ignores invalid usage windows instead of failing (#11)", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "recommend_model",
      arguments: {
        task: "x",
        taskType: "code",
        capabilities: fixture(),
        usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "daily", usedPercent: 120 }] }],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(
      (res.structuredContent as { candidates: { providerInstanceId: string }[] }).candidates[0]!.providerInstanceId,
    ).toBe("claudeAgent");
  });

  it("lists every task type on its own line in the tool description (#3)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === "recommend_model")!.description!;
    for (const t of ["review", "debug", "plan", "research", "quick", "code", "design", "writing"]) {
      expect(desc).toMatch(new RegExp(`\\n- ${t}: `));
    }
  });
});
