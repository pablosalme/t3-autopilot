// End-to-end test over stdio. Starts the built server the way an agent CLI
// does (a child process speaking MCP on stdin/stdout), connects the MCP SDK
// client to it and walks the flow the orchestrator snippet asks for:
// recommend with capabilities, recommend from the cache, merge a `search`
// output, log the delegation and its outcome, read the stats.
//
// It uses Node's own test runner, so it also runs on Node versions Vitest
// does not support:
//
//   npm run build && npm run test:e2e
//
// T3_AUTOPILOT_E2E_BIN=<installed t3-autopilot executable> runs the same test
// against that executable instead of dist/cli.js (scripts/pack-check.mjs does).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const fixture = (name) => JSON.parse(readFileSync(join(root, "test", "fixtures", "drivers", `${name}.json`), "utf8"));
const bin = process.env.T3_AUTOPILOT_E2E_BIN;
const cli = join(root, "dist", "cli.js");
if (!bin && !existsSync(cli)) throw new Error("dist/cli.js is missing: run `npm run build` first.");

/** A fresh data directory, so the test never reads or writes ~/.t3-autopilot. */
const newHome = () => mkdtempSync(join(tmpdir(), "t3-autopilot-e2e-"));

/** Start the server over stdio with `home` as its data directory. */
async function start(home) {
  const transport = new StdioClientTransport({
    ...(bin ? { command: bin, args: [] } : { command: process.execPath, args: [cli] }),
    env: { ...process.env, T3_AUTOPILOT_HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "t3-autopilot-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/** Run the CLI with arguments; returns { status, stdout, stderr }. */
function runCli(args, home) {
  const env = { ...process.env, T3_AUTOPILOT_HOME: home };
  const res = bin
    ? // An installed bin is a .cmd shim on Windows, which only runs through a shell.
      spawnSync(process.platform === "win32" ? `"${bin}"` : bin, args, { env, encoding: "utf8", shell: process.platform === "win32" })
    : spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  if (res.error) throw res.error;
  return res;
}

const text = (res) => res.content.map((c) => c.text ?? "").join("\n");
const ids = (data) => data.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
const warned = (data) => data.warnings.map((w) => w.slice(0, w.indexOf(":")));

describe(`orchestrator flow over stdio (${bin ? "installed bin" : "dist/cli.js"})`, () => {
  const home = newHome();
  let client;
  let transport;
  const task = { task: "Implement the CSV export endpoint", taskType: "code", size: "medium", criticality: "normal" };
  async function recommend(args) {
    const res = await client.callTool({ name: "recommend_model", arguments: { ...task, ...args } });
    assert.ok(!res.isError, text(res));
    return res.structuredContent;
  }

  before(async () => {
    ({ client, transport } = await start(home));
  });
  after(async () => {
    await client?.close();
  });

  it("initializes and lists the four tools", async () => {
    assert.deepEqual(client.getServerVersion(), { name: "t3-autopilot", version: pkg.version });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_stats", "log_delegation", "log_outcome", "recommend_model"]);
    const description = tools.find((t) => t.name === "recommend_model").description;
    for (const type of ["review", "debug", "plan", "research", "quick", "code", "design", "writing"]) {
      assert.match(description, new RegExp(`\\n- ${type}: `));
    }
  });

  it("recommends from the full orchestrator_capabilities output", async () => {
    const data = await recommend({ capabilities: fixture("mixed") });
    assert.equal(data.capabilitiesFrom, "call");
    assert.equal(data.taskType, "code");
    assert.equal(data.classification.source, "given");
    assert.deepEqual(ids(data), ["codex/gpt-9.1-sol", "cursor/claude-opus-9-1", "opencode/openrouter/anthropic/claude-opus-9.1"]);
    assert.deepEqual(data.candidates[0].options, [{ id: "reasoningEffort", value: "high" }]);
    assert.equal(data.candidates[0].source, "taskType");
    assert.equal(data.candidates[0].sameAsOrchestrator, false);
    assert.match(data.candidates[0].reason, /^code #2: latest gpt on codex is gpt-9\.1-sol, effort high$/);
    // Cursor, OpenCode and Pi list a short list; each warning names the searches to run.
    assert.deepEqual(warned(data), ["cursor", "opencode", "pi"]);
    assert.match(data.warnings[0], /Call orchestrator_capabilities with search "cursor opus", "cursor composer"/);
  });

  it("reuses the cached capabilities when the call omits them", async () => {
    const data = await recommend({});
    assert.equal(data.capabilitiesFrom, "cache");
    assert.deepEqual(ids(data), ["codex/gpt-9.1-sol", "cursor/claude-opus-9-1", "opencode/openrouter/anthropic/claude-opus-9.1"]);
  });

  it("merges a search output: the hidden model wins and only the searched provider's warning goes", async () => {
    const data = await recommend({ capabilities: fixture("search-mixed-cursor-opus"), mergeCapabilities: true });
    assert.equal(data.capabilitiesFrom, "merged");
    assert.deepEqual(ids(data), ["codex/gpt-9.1-sol", "cursor/claude-opus-9-2", "opencode/openrouter/anthropic/claude-opus-9.1"]);
    assert.deepEqual(data.candidates[1].options, [{ id: "effort", value: "high" }]);
    assert.deepEqual(warned(data), ["opencode", "pi"]);
  });

  it("keeps the merged capabilities for the next call", async () => {
    const data = await recommend({});
    assert.equal(data.capabilitiesFrom, "cache");
    assert.equal(data.candidates[1].model, "claude-opus-9-2");
    assert.deepEqual(warned(data), ["opencode", "pi"]);
    // Another task type on the same cache: an independent review avoids the orchestrator's provider (codex).
    const review = await recommend({ task: "Review the export endpoint PR", taskType: "review", criticality: "high" });
    assert.equal(review.capabilitiesFrom, "cache");
    assert.deepEqual(ids(review), ["cursor/gpt-9.1-sol", "opencode/openai/gpt-9.1-sol", "kiro/gpt-8.6-sol"]);
    assert.deepEqual(review.candidates[0].options, [{ id: "reasoning", value: "xhigh" }]);
  });

  let delegationId;
  it("logs the delegation", async () => {
    const res = await client.callTool({
      name: "log_delegation",
      arguments: {
        taskType: "code",
        providerInstanceId: "codex",
        model: "gpt-9.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
        recommendedRank: 1,
        childThreadId: "thread:e2e-child",
        summary: "CSV export endpoint",
      },
    });
    assert.ok(!res.isError, text(res));
    delegationId = res.structuredContent.delegationId;
    assert.match(delegationId, /^d_[0-9a-f]{12}$/);
    assert.equal(res.structuredContent.logged.recommendedRank, 1);
  });

  it("logs the outcome with the delegationId", async () => {
    const res = await client.callTool({ name: "log_outcome", arguments: { delegationId, outcome: "success", note: "accepted as is" } });
    assert.ok(!res.isError, text(res));
    assert.equal(res.structuredContent.logged.delegationId, delegationId);
    assert.equal(res.structuredContent.logged.outcome, "success");
    const unknown = await client.callTool({ name: "log_outcome", arguments: { delegationId: "d_000000000000", outcome: "success" } });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /Unknown delegationId/);
  });

  it("reports the stats from the log in its own data directory", async () => {
    const res = await client.callTool({ name: "get_stats", arguments: {} });
    assert.ok(!res.isError, text(res));
    const stats = res.structuredContent;
    assert.equal(stats.log, join(home, "log.jsonl"));
    assert.deepEqual(stats.total, { delegations: 1, success: 1, failure: 0, corrected: 0, pending: 0, successRate: 1 });
    assert.equal(stats.byTaskType.code.byModel["codex/gpt-9.1-sol"].success, 1);
    assert.deepEqual(stats.followedFirstRecommendation, { followed: 1, logged: 1 });
    const kinds = readFileSync(join(home, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).kind);
    assert.deepEqual(kinds, ["delegation", "outcome"]);
  });

  it("exits on its own when the client closes stdin", async () => {
    const pid = transport.pid;
    assert.ok(pid);
    const t0 = Date.now();
    await client.close();
    client = undefined;
    // The SDK waits up to 2 s for the server to exit before it sends SIGTERM.
    assert.ok(Date.now() - t0 < 1900, `the server took ${Date.now() - t0} ms to exit`);
    assert.throws(() => process.kill(pid, 0));
  });
});

describe("a broken user policy over stdio", () => {
  const home = newHome();
  const policyFile = join(home, "policy.yaml");
  let client;
  let transport;
  before(async () => {
    writeFileSync(policyFile, "taskTypes: [unclosed\n");
    ({ client, transport } = await start(home));
  });
  after(async () => {
    await client?.close();
  });

  it("does not stop the server: tools report the file, and fixing it needs no restart", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    const args = { task: "x", taskType: "code", capabilities: fixture("codex") };
    const broken = await client.callTool({ name: "recommend_model", arguments: args });
    assert.equal(broken.isError, true);
    assert.ok(text(broken).startsWith(`${policyFile}: cannot read policy YAML:`), text(broken));
    const stats = await client.callTool({ name: "get_stats", arguments: {} });
    assert.ok(!stats.isError, text(stats));

    writeFileSync(policyFile, "maxCandidates: 1\n");
    const fixed = await client.callTool({ name: "recommend_model", arguments: args });
    assert.ok(!fixed.isError, text(fixed));
    assert.deepEqual(ids(fixed.structuredContent), ["codex/gpt-9.1-sol"]);

    writeFileSync(policyFile, "maxCandidates: 9\n");
    const invalid = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code" } });
    assert.equal(invalid.isError, true);
    assert.ok(text(invalid).startsWith(`Invalid policy (${policyFile}, on top of the default policy)`), text(invalid));
    assert.match(text(invalid), /→ at maxCandidates/);
    // Still alive.
    assert.doesNotThrow(() => process.kill(transport.pid, 0));
  });
});

describe("CLI commands", () => {
  it("--version, --help and snippet", () => {
    const home = newHome();
    const version = runCli(["--version"], home);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `${pkg.version}\n`);
    assert.match(runCli(["--help"], home).stdout, /^t3-autopilot \d+\.\d+\.\d+: model selection MCP server for T3 Code orchestrators\./);
    const snippet = runCli(["snippet"], home);
    assert.equal(snippet.status, 0);
    assert.ok(snippet.stdout.startsWith("## Model selection for delegated tasks (t3-autopilot)\n"));
    assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(snippet.stdout), "README shows the snippet the CLI prints");
  });

  it("init-policy writes the template once into the data directory", () => {
    const home = newHome();
    const first = runCli(["init-policy"], home);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(join(home, "policy.yaml")));
    const second = runCli(["init-policy"], home);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists; not overwritten/);
  });

  it("rejects an unknown command", () => {
    const res = runCli(["frobnicate"], newHome());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Unknown command "frobnicate"/);
  });
});
