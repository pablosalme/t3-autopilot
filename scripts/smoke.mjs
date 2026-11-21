// Smoke test: start the built server over stdio, as an agent CLI would, and
// call recommend_model with several invented capabilities fixtures.
// Usage: npm run build && npm run smoke
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "t3-autopilot-smoke-"));
const load = (rel) => JSON.parse(readFileSync(join(root, "test", "fixtures", rel), "utf8"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "cli.js")],
  env: { ...process.env, T3_AUTOPILOT_HOME: home },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

async function recommend(label, args, { expectError = false } = {}) {
  const res = await client.callTool({ name: "recommend_model", arguments: args });
  console.log(`\n=== ${label}`);
  if (res.isError) {
    console.log(res.content[0].text);
    check(label, expectError, "error");
    return undefined;
  }
  const data = res.structuredContent;
  console.log(
    JSON.stringify(
      {
        taskType: data.taskType,
        candidates: data.candidates,
        warnings: data.warnings,
        capabilitiesFrom: data.capabilitiesFrom,
      },
      null,
      2,
    ),
  );
  check(label, !expectError && data.candidates.length > 0, `${data.candidates.length} candidate(s)`);
  return data;
}

// 1. A single non-Claude provider (Kiro), with dotted model ids.
await recommend("single provider: kiro", {
  task: "Implement the CSV export endpoint",
  taskType: "code",
  capabilities: load("drivers/kiro.json"),
});
// 2. A mix of providers; Cursor, OpenCode and Pi have short lists (omittedModels).
await recommend("mixed: codex + cursor + opencode + kiro + pi", {
  task: "Review the PR",
  taskType: "review",
  capabilities: load("drivers/mixed.json"),
});
// 3. Only providers t3-autopilot does not know: generic fallback, low confidence.
await recommend("only unknown providers", {
  task: "Fix the flaky upload test",
  taskType: "debug",
  capabilities: load("drivers/unknown-only.json"),
});
// 4. Cached capabilities: the previous call's are reused.
const cached = await recommend("cached capabilities (no capabilities argument)", {
  task: "Rename the util module",
  taskType: "quick",
});
check("cache reused", cached?.capabilitiesFrom === "cache");
// 5. Every provider disabled: a clear error.
await recommend(
  "all providers disabled",
  { task: "x", taskType: "code", capabilities: load("drivers/all-disabled.json") },
  { expectError: true },
);
// 6. The original mixed fixture with usage passed in the call.
await recommend("usage-aware (claudeAgent weekly 88%)", {
  task: "Fix the flaky upload test that fails on CI",
  taskType: "debug",
  capabilities: load("capabilities.json"),
  usage: [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 88 }] }],
});

// 7. Subscription profiles: setupNeeded asks for them, set_subscription saves one, and it applies.
const subsCaps = load("subscriptions-setup.json");
const before = await recommend("setupNeeded before any profile", {
  task: "Research the export formats",
  taskType: "research",
  capabilities: subsCaps,
});
check("setupNeeded lists every provider", before?.setupNeeded?.providers?.length === 4);
const saved = await client.callTool({
  name: "set_subscription",
  arguments: {
    providerInstanceId: "cursor",
    plan: "X Subscription Premium, includes Cursor Pro",
    quota: "standard",
    quotaPool: "x-premium",
    includedFamilies: ["composer", "grok", "grok-build", "grok-fast"],
  },
});
check("set_subscription", !saved.isError, saved.isError ? saved.content[0].text : "");
const after = await recommend("Cursor's paid models left out", { task: "Review the PR", taskType: "review" });
check(
  "no paid Cursor model",
  after !== undefined &&
    !after.candidates.some((c) => c.providerInstanceId === "cursor" && /gpt|gemini|claude/.test(c.model)),
);
check(
  "setupNeeded no longer lists cursor",
  !after?.setupNeeded?.providers?.some((p) => p.providerInstanceId === "cursor"),
);

// 8. herdr: the probe of the agent CLIs on PATH, and the hc command that starts each candidate.
const herdr = await recommend("herdr: probe output", {
  task: "Implement the CSV export endpoint",
  taskType: "code",
  host: "herdr",
  capabilities: readFileSync(join(root, "test", "fixtures", "herdr", "probe-linux.txt"), "utf8"),
  orchestrator: { agent: "claude", model: "opus" },
});
check("herdr: host in the result", herdr?.host === "herdr");
check(
  "herdr: every candidate starts with hc run, one argument per element",
  herdr?.candidates.every(
    (c) => c.launch?.argv.slice(0, 3).join(" ") === "hc run --bg" && c.launch.argv.every((a) => !/\s/.test(a)),
  ) === true,
);

const out = await client.callTool({
  name: "log_outcome",
  arguments: {
    taskType: "debug",
    providerInstanceId: "codex",
    model: "gpt-6.2-codex",
    outcome: "success",
    note: "smoke",
  },
});
check("log_outcome", !out.isError);
const stats = await client.callTool({ name: "get_stats", arguments: {} });
check("get_stats", stats.structuredContent?.total?.success === 1, JSON.stringify(stats.structuredContent?.total));
await client.close();

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
