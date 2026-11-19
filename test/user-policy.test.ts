import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { connectClient, fixture, resultText, tempDir } from "./helpers.js";

// The server as the CLI starts it (no options): the user policy is
// $T3_AUTOPILOT_HOME/policy.yaml (~/.t3-autopilot/policy.yaml by default)
// and it is re-read on every tool call.
const saved = process.env.T3_AUTOPILOT_HOME;
let home: string;
let policyFile: string;
beforeEach(() => {
  home = tempDir();
  policyFile = join(home, "policy.yaml");
  process.env.T3_AUTOPILOT_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.T3_AUTOPILOT_HOME;
  else process.env.T3_AUTOPILOT_HOME = saved;
});

const writePolicy = (yaml: string) => writeFileSync(policyFile, yaml, "utf8");
const start = () => connectClient(createServer());
type Rec = { candidates: { providerInstanceId: string; model: string }[]; skipped: string[] };
const recommend = (client: Awaited<ReturnType<typeof start>>, args: Record<string, unknown> = {}) =>
  client.callTool({
    name: "recommend_model",
    arguments: { task: "x", taskType: "code", capabilities: fixture(), ...args },
  });

describe("an invalid user policy", () => {
  it("is reported by every tool that needs it, and the server keeps working once it is fixed", async () => {
    writePolicy("taskTypes: [unclosed\n");
    const client = await start();

    // Starting and listing tools does not depend on the policy.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    expect(tools.find((t) => t.name === "recommend_model")!.description).toMatch(/\n- code/);

    const rec = await recommend(client);
    expect(rec.isError).toBe(true);
    expect(resultText(rec)).toContain(`${policyFile}: cannot read policy YAML:`);
    expect(resultText(rec)).toMatch(/end with a \] at line \d+, column \d+/);

    const del = await client.callTool({
      name: "log_delegation",
      arguments: { taskType: "code", providerInstanceId: "codex", model: "m" },
    });
    expect(del.isError).toBe(true);
    expect(resultText(del)).toContain(policyFile);
    const out = await client.callTool({
      name: "log_outcome",
      arguments: { taskType: "code", providerInstanceId: "codex", model: "m", outcome: "success" },
    });
    expect(out.isError).toBe(true);

    // get_stats only reads the log.
    const stats = await client.callTool({ name: "get_stats", arguments: {} });
    expect(stats.isError).toBeFalsy();
    expect((stats.structuredContent as { total: { delegations: number } }).total.delegations).toBe(0);

    // Fixed without restarting the server.
    writePolicy("maxCandidates: 1\n");
    const fixed = await recommend(client);
    expect(fixed.isError).toBeFalsy();
    expect((fixed.structuredContent as Rec).candidates).toHaveLength(1);
  });

  it.each([
    ["a value out of range", "maxCandidates: 7\n", /Too big: expected number to be <=3\s+→ at maxCandidates/],
    ["a wrong type", "excludeProviders: cursor\n", /expected array, received string\s+→ at excludeProviders/],
    ["a bad usage threshold", "usage:\n  thresholds: { weekly: 150 }\n", /→ at usage\.thresholds\.weekly/],
    ["an unsupported version", "version: 2\n", /→ at version/],
    [
      "an unknown family",
      "taskTypes:\n  code:\n    candidates:\n      - { provider: claudeAgent, family: nope }\n",
      /- taskTypes\.code\.candidates\[0\]: unknown family "nope"/,
    ],
    ["an invalid regex", "families:\n  x:\n    match: { '*': '([' }\n", /- families\.x\.match\.\*: invalid regex/],
    [
      "a candidate without provider",
      "taskTypes:\n  code:\n    candidates:\n      - { family: gpt }\n",
      /needs `provider`/,
    ],
    ["removing the default task type", "taskTypes:\n  code: null\n", /defaultTaskType "code" is not a task type/],
  ])("%s: the message names the user's file and the entry", async (_label, yaml, expected) => {
    writePolicy(yaml);
    const res = await recommend(await start());
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain(`Invalid policy (${policyFile}, on top of the default policy)`);
    expect(resultText(res)).toMatch(expected);
  });

  it("rejects a top-level list", async () => {
    writePolicy("- maxCandidates: 1\n");
    const res = await recommend(await start());
    expect(res.isError).toBe(true);
    expect(resultText(res)).toBe(`${policyFile}: expected a YAML mapping at the top level`);
  });
});

describe("a partial user policy", () => {
  it("an empty file is the default policy", async () => {
    const client = await start();
    const before = (await recommend(client)).structuredContent as Rec;
    writePolicy("");
    const after = (await recommend(client)).structuredContent as Rec;
    expect(after.candidates).toEqual(before.candidates);
    expect(after.candidates).toHaveLength(3);
  });

  it("changes only the keys it sets", async () => {
    writePolicy("excludeProviders: [claudeAgent]\nmaxCandidates: 2\n");
    const res = await recommend(await start());
    const data = res.structuredContent as Rec;
    expect(data.candidates.map((c) => `${c.providerInstanceId}/${c.model}`)).toEqual([
      "codex/gpt-6.2-codex",
      "cursor/claude-opus-7",
    ]);
    expect(data.skipped).toContain("claudeAgent: listed in excludeProviders");
  });

  it("can remove a task type; the others stay", async () => {
    writePolicy("taskTypes:\n  quick: null\n");
    const client = await start();
    const quick = await recommend(client, { taskType: "quick" });
    expect(quick.isError).toBe(true);
    expect(resultText(quick)).toBe(
      'Unknown taskType "quick". Known types: review, debug, plan, research, code, design, writing',
    );
    expect((await recommend(client)).isError).toBeFalsy();
  });

  it("merges usage thresholds one level deep", async () => {
    writePolicy("usage:\n  thresholds: { weekly: 50 }\n");
    const client = await start();
    const busy = [{ providerInstanceId: "claudeAgent", windows: [{ kind: "weekly", usedPercent: 60 }] }];
    expect(
      ((await recommend(client, { usage: busy })).structuredContent as Rec).candidates[0]!.providerInstanceId,
    ).toBe("codex");
    // session keeps the default 80%.
    const session = [{ providerInstanceId: "claudeAgent", windows: [{ kind: "session", usedPercent: 60 }] }];
    expect(
      ((await recommend(client, { usage: session })).structuredContent as Rec).candidates[0]!.providerInstanceId,
    ).toBe("claudeAgent");
  });
});
