// Smoke test: start the built server over stdio, as an agent CLI would, and
// call recommend_model with the test fixture. Usage: npm run build && npm run smoke
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("..", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "t3-autopilot-smoke-"));
const capabilities = JSON.parse(readFileSync(join(root, "test/fixtures/capabilities.json"), "utf8"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/cli.js")],
  env: { ...process.env, T3_AUTOPILOT_HOME: home },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const res = await client.callTool({
  name: "recommend_model",
  arguments: {
    task: "Fix the flaky upload test that fails on CI",
    size: "medium",
    capabilities,
    usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 88 }] }],
  },
});
console.log(res.content[0].text);

const out = await client.callTool({
  name: "log_outcome",
  arguments: { taskType: "debug", providerInstanceId: "codex", model: "gpt-6.2-codex", outcome: "success", note: "smoke" },
});
console.log("log_outcome isError:", Boolean(out.isError));
const stats = await client.callTool({ name: "get_stats", arguments: {} });
console.log("get_stats total:", JSON.stringify(stats.structuredContent.total));
await client.close();
