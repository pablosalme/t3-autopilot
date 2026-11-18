import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/policy.js";
import { createServer } from "../src/server.js";
import { fixture, tempDir } from "./helpers.js";

async function connect() {
  const dir = tempDir();
  const server = createServer({
    loadPolicy: () => loadPolicy({ userPath: join(dir, "policy.yaml") }),
    logPath: () => join(dir, "log.jsonl"),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("MCP server", () => {
  it("lists the four tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_stats", "log_delegation", "log_outcome", "recommend_model"]);
  });

  it("recommends, logs and reports stats end to end", async () => {
    const client = await connect();
    const rec = await client.callTool({
      name: "recommend_model",
      arguments: { task: "Implement the export endpoint", capabilities: fixture() },
    });
    expect(rec.isError).toBeFalsy();
    const data = rec.structuredContent as { taskType: string; candidates: { providerInstanceId: string; model: string }[] };
    expect(data.candidates[0]).toMatchObject({ providerInstanceId: "claudeAgent", model: "claude-opus-7-1" });

    const out = await client.callTool({
      name: "log_outcome",
      arguments: { taskType: data.taskType, providerInstanceId: "claudeAgent", model: "claude-opus-7-1", outcome: "success" },
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
});
