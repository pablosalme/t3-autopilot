import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HELP, POLICY_TEMPLATE, runCli } from "../src/cliMain.js";
import { userPolicyPath } from "../src/paths.js";
import { loadPolicy } from "../src/policy.js";
import { VERSION } from "../src/server.js";
import { INSTRUCTIONS_SNIPPET } from "../src/snippet.js";
import { tempDir } from "./helpers.js";

const saved = process.env.T3_AUTOPILOT_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.T3_AUTOPILOT_HOME;
  else process.env.T3_AUTOPILOT_HOME = saved;
});

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(argv, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

describe("CLI", () => {
  it("prints the snippet, help and version", async () => {
    expect(await run("snippet")).toEqual({ code: 0, out: INSTRUCTIONS_SNIPPET, err: "" });
    expect((await run("--help")).out).toBe(HELP);
    expect((await run("--version")).out).toBe(`${VERSION}\n`);
  });

  it("rejects an unknown command with exit code 2", async () => {
    const r = await run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Unknown command "frobnicate"/);
  });

  it("init-policy writes a short commented template that loads as the default policy (#16)", async () => {
    process.env.T3_AUTOPILOT_HOME = tempDir();
    const r = await run("init-policy");
    expect(r.code).toBe(0);
    const text = readFileSync(userPolicyPath(), "utf8");
    expect(text).toBe(POLICY_TEMPLATE);
    expect(text.split("\n").length).toBeLessThan(45);
    // Everything is commented out: the override is empty and the default applies.
    expect(parse(text)).toBeNull();
    const { policy, sources } = loadPolicy();
    expect(sources).toHaveLength(2);
    expect(policy.taskTypes.code).toBeDefined();
  });

  it("init-policy never overwrites an existing file", async () => {
    process.env.T3_AUTOPILOT_HOME = tempDir();
    writeFileSync(join(process.env.T3_AUTOPILOT_HOME, "policy.yaml"), "maxCandidates: 1\n");
    const r = await run("init-policy");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(readFileSync(userPolicyPath(), "utf8")).toBe("maxCandidates: 1\n");
  });

  it("the snippet asks for a recommendation before every child, native ones too (#2, #3, #15)", () => {
    expect(INSTRUCTIONS_SNIPPET).toMatch(/including the ones you would start with your native subagent tool/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/`taskType` \(always/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/delegate inheriting your own provider and model/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/Tell the user in one line which provider and model you picked/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/call `log_delegation`/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/fails with "No capabilities yet", call `orchestrator_capabilities`/);
  });

  it("the README shows the same snippet the CLI prints, and no npx install before publishing (#1)", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(INSTRUCTIONS_SNIPPET);
    const blocks = readme.match(/```[a-z]*\n[\s\S]*?```/g) ?? [];
    expect(blocks.some((b) => b.includes("npx"))).toBe(false);
    expect(readme).toContain("node /path/to/t3-autopilot/dist/cli.js");
  });
});
