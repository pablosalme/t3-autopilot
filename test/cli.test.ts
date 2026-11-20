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

  it("--help lists every alias, and each one does what it says", async () => {
    for (const alias of ["[serve]", "--help | -h | help", "--version | -v"]) expect(HELP).toContain(alias);
    for (const alias of ["--help", "-h", "help"]) expect(await run(alias)).toEqual({ code: 0, out: HELP, err: "" });
    for (const alias of ["--version", "-v"]) {
      expect(await run(alias)).toEqual({ code: 0, out: `${VERSION}\n`, err: "" });
    }
    // Every command of the usage text is one runCli knows (serve and the bare command start the server).
    const commands = [...HELP.matchAll(/^ {2}t3-autopilot (\S+)/gm)].map((m) => m[1]);
    expect(commands).toEqual(["[serve]", "snippet", "init-policy", "--help", "--version"]);
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

  it("the snippet asks the user about providers in setupNeeded and saves the answers with set_subscription", () => {
    expect(INSTRUCTIONS_SNIPPET).toMatch(/If the result has `setupNeeded`, ask the user its questions/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/save each answer with `set_subscription`/);
    expect(INSTRUCTIONS_SNIPPET).toMatch(/costs extra or is outside its subscription profile, ask the user/);
  });

  it("the snippet asks for the whole capabilities output, never a trimmed copy", () => {
    expect(INSTRUCTIONS_SNIPPET).toMatch(/Pass it whole, exactly as returned, never trimmed or summarised/);
  });

  it("both READMEs show the same snippet the CLI prints and install with npx (#1)", () => {
    for (const file of ["README.md", "docs/README.es.md"]) {
      const readme = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // The copy of the snippet, word for word (it stays in English in the Spanish README).
      expect(readme, file).toContain(`\`\`\`markdown\n${INSTRUCTIONS_SNIPPET}\`\`\``);
      // Every npx line of a code block runs the published package by name: no path, version or other package.
      const blocks = readme.match(/```[a-z]*\n[\s\S]*?```/g) ?? [];
      const npxLines = blocks.flatMap((b) => b.split("\n")).filter((line) => line.includes("npx"));
      expect(npxLines.length, file).toBeGreaterThan(0);
      for (const line of npxLines) {
        expect(line, file).toMatch(/npx(?: |", "args": \[")-y(?: |", ")t3-autopilot(?:"\]| |$)/);
      }
      // The registration commands, and the alternative from a source checkout.
      expect(readme, file).toContain("claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot\n");
      expect(readme, file).toContain("npx -y t3-autopilot snippet\n");
      expect(readme, file).toContain(
        "claude mcp add --scope user t3-autopilot -- node /path/to/t3-autopilot/dist/cli.js",
      );
    }
  });

  it("both READMEs load their images from absolute URLs, which npm does not rewrite", () => {
    for (const file of ["README.md", "docs/README.es.md"]) {
      const readme = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const tags = readme.match(/<(?:img|source)\b[^>]*>/g) ?? [];
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) {
        const urls = [...tag.matchAll(/\b(?:src|srcset)="([^"]*)"/g)].map((m) => m[1]);
        expect(urls.length, `${file}: ${tag}`).toBeGreaterThan(0);
        for (const url of urls) expect(url, `${file}: ${tag}`).toMatch(/^https:\/\//);
      }
    }
  });
});
