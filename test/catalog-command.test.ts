import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentCatalog,
  agentCommand,
  BRIEF,
  checkCatalog,
  isToken,
  loadCatalog,
  resolveAgent,
} from "../src/catalog.js";
import { defaultPolicy, tempDir } from "./helpers.js";

const families = Object.keys(defaultPolicy().families);

function builtin(): AgentCatalog {
  return loadCatalog({ userPath: join(tempDir(), "missing.yaml"), families }).catalog;
}

function withUser(user: string) {
  const userPath = join(tempDir(), "catalog.yaml");
  writeFileSync(userPath, user);
  return loadCatalog({ userPath, families });
}

/** A catalog with the built-in version and `agents`, checked. */
function catalogOf(agents: Record<string, unknown>) {
  return checkCatalog({ version: 1, agents }, "test", families);
}

describe("agentCommand: argv per agent of the built-in catalog", () => {
  const catalog = builtin();
  const cases: [string, { model?: string; effort?: string }, string[], "argv" | "send"][] = [
    ["claude", { model: "opus", effort: "high" }, ["claude", "--model", "opus", "--effort", "high", BRIEF], "argv"],
    ["claude", { model: "haiku" }, ["claude", "--model", "haiku", BRIEF], "argv"],
    [
      "codex",
      { model: "default", effort: "xhigh" },
      ["codex", "--no-daemon", "-c", "model_reasoning_effort=xhigh", BRIEF],
      "argv",
    ],
    ["cursor", { model: "auto" }, ["cursor-agent", "--model", "auto", BRIEF], "argv"],
    ["grok", { model: "default", effort: "low" }, ["grok", "--reasoning-effort", "low", "--", BRIEF], "argv"],
    ["opencode", { model: "default" }, ["opencode", "--prompt", BRIEF], "argv"],
    [
      "pi",
      { model: "openai/gpt-9.1-sol", effort: "medium" },
      ["pi", "--model", "openai/gpt-9.1-sol", "--thinking", "medium", BRIEF],
      "argv",
    ],
    ["gemini", {}, ["gemini", "--prompt-interactive", BRIEF], "argv"],
    ["gemini", { model: "gemini-9-pro" }, ["gemini", "-m", "gemini-9-pro", "--prompt-interactive", BRIEF], "argv"],
    [
      "antigravity",
      { model: "gemini-9-pro", effort: "high" },
      ["agy", "--model", "gemini-9-pro", "--effort", "high", "--prompt-interactive", BRIEF],
      "argv",
    ],
    [
      "muse",
      { model: "muse-spark-9", effort: "max" },
      ["muse", "--model", "muse-spark-9", "--reasoning-effort", "max"],
      "send",
    ],
    ["kiro", {}, ["kiro-cli", "chat", "--tui"], "send"],
  ];
  for (const [id, selection, argv, brief] of cases) {
    it(`${id} ${JSON.stringify(selection)}`, () => {
      expect(agentCommand(catalog, id, selection)).toEqual({ agent: id, argv, brief });
    });
  }

  it("starts every agent with its default model, one safe word per argument", () => {
    for (const [id, agent] of Object.entries(catalog.agents)) {
      const { argv } = agentCommand(catalog, id);
      expect(argv[0]).toBe(agent.exe);
      for (const word of argv)
        expect(word === BRIEF || word === "--" || /^--?[A-Za-z0-9]/.test(word) || isToken(word)).toBe(true);
    }
  });

  it("gives every agent its program, and records the CLI version checked where the CLI was installed", () => {
    const checked = Object.entries(catalog.agents)
      .filter(([, a]) => a.checked !== undefined)
      .map(([id]) => id);
    expect(checked).toEqual(["claude", "codex", "grok", "opencode"]);
    for (const agent of Object.values(catalog.agents)) expect(agent.exe).toBeDefined();
  });

  it("runs the program herdr found: an executable alias of the agent, or its exe", () => {
    expect(agentCommand(catalog, "opencode2").argv).toEqual(["opencode2", "--prompt", BRIEF]);
    expect(agentCommand(catalog, "cursor-agent").argv[0]).toBe("cursor-agent");
    expect(agentCommand(catalog, "cursor").argv[0]).toBe("cursor-agent");
    expect(agentCommand(catalog, "agy")).toMatchObject({
      agent: "antigravity",
      argv: ["agy", "--prompt-interactive", BRIEF],
    });
  });

  it("refuses a model or an effort the CLI takes no flag for", () => {
    expect(() => agentCommand(catalog, "opencode", { model: "anthropic/claude-opus-9-2" })).toThrow(
      /opencode takes no model at start\. Set agents\.opencode\.flags\.model in catalog\.yaml/,
    );
    expect(() => agentCommand(catalog, "cursor", { effort: "high" })).toThrow(/cursor takes no effort at start/);
    expect(() => agentCommand(catalog, "kiro", { model: "x" })).toThrow(/kiro takes no model at start/);
  });

  it("refuses a model or an effort that is not one safe word", () => {
    for (const model of ["--dangerously-skip-permissions", "gpt 9", "$(id)", "a;b", "`id`", ""]) {
      expect(() => agentCommand(catalog, "claude", { model }), model).toThrow(/is not one command-line word/);
    }
    expect(() => agentCommand(catalog, "codex", { effort: "high;rm" })).toThrow(
      /effort "high;rm" is not one command-line word/,
    );
    expect(() => agentCommand(catalog, "codex", { effort: "-x" })).toThrow(/is not one command-line word/);
    // A word that only becomes too long once the effort is in it.
    expect(() => agentCommand(catalog, "codex", { effort: "e".repeat(200) })).toThrow(
      /makes "model_reasoning_effort=e+", which is not one command-line word/,
    );
  });

  it("refuses an agent the catalog does not have", () => {
    expect(() => agentCommand(catalog, "goose")).toThrow(/"goose" is not an agent of the catalog/);
    // `agent` is Cursor's newer name, but on some machines it is Grok's binary: it is no alias.
    expect(() => agentCommand(catalog, "agent")).toThrow(/not an agent of the catalog/);
  });

  it("sends the brief after start by default", () => {
    const { catalog: c } = withUser("agents:\n  goose: { models: [default] }\n");
    expect(agentCommand(c, "goose")).toEqual({ agent: "goose", argv: ["goose"], brief: "send" });
  });

  it("follows the user's flags, with the effort inside a word and a model for OpenCode's mini interface", () => {
    const { catalog: c, warnings } = withUser(
      [
        "agents:",
        "  opencode:",
        "    models: [anthropic/claude-opus-9-2]",
        "    args: [mini]",
        '    flags: { model: [-m, "{model}"], effort: ["--variant={effort}"] }',
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(agentCommand(c, "opencode", { model: "anthropic/claude-opus-9-2", effort: "high" }).argv).toEqual([
      "opencode",
      "mini",
      "-m",
      "anthropic/claude-opus-9-2",
      "--variant=high",
      "--prompt",
      BRIEF,
    ]);
  });
});

describe("resolveAgent in herdr", () => {
  const catalog = builtin();

  it("finds an agent by its program or one of its executable aliases, in herdr only", () => {
    expect(resolveAgent(catalog, "herdr", "cursor-agent")).toBe("cursor");
    expect(resolveAgent(catalog, "herdr", "kiro-cli")).toBe("kiro");
    expect(resolveAgent(catalog, "herdr", "agy")).toBe("antigravity");
    expect(resolveAgent(catalog, "herdr", "opencode2")).toBe("opencode");
    expect(resolveAgent(catalog, "herdr", "agent")).toBeUndefined();
    expect(resolveAgent(catalog, "orca", "cursor-agent")).toBeUndefined();
  });

  it("prefers a host alias to a program name", () => {
    const { catalog: c } = withUser("hosts:\n  herdr:\n    aliases: { agent: cursor }\n");
    expect(resolveAgent(c, "herdr", "agent")).toBe("cursor");
    expect(agentCommand(c, "agent").argv[0]).toBe("cursor-agent");
  });
});

describe("herdr fields: validation", () => {
  it("accepts the documented forms", () => {
    const { warnings } = catalogOf({
      a: {
        exe: "a-cli",
        aliases: ["a2"],
        args: ["chat", "--tui", "-x", "--"],
        flags: { model: ["--model", "{model}"], effort: ["-c", "effort={effort}"] },
        prompt: ["--", BRIEF],
        checked: "1.2.3",
      },
      b: { prompt: "positional", flags: { effort: ["--effort={effort}"] } },
      c: { prompt: "send" },
    });
    expect(warnings).toEqual([]);
  });

  it("rejects placeholders that are missing, repeated or inside a word where only a whole word may be", () => {
    for (const flags of [
      { model: ["--model"] },
      { model: ["--model", "{model}", "{model}"] },
      { model: ["--model={model}"] },
      { effort: ["--effort", "{effort}{effort}"] },
      { effort: ["--effort", "{model}"] },
      { model: [] },
    ]) {
      expect(() => catalogOf({ a: { flags } }), JSON.stringify(flags)).toThrow(/Invalid agent catalog \(test\)/);
    }
    expect(() => catalogOf({ a: { flags: { model: ["--model", "{model}"], extra: ["x"] } } })).not.toThrow();
  });

  it("rejects words with spaces or shell characters in exe, aliases, args, flags and prompt", () => {
    for (const agent of [
      { exe: "my agent" },
      { exe: "--x" },
      { aliases: ["a;b"] },
      { args: ["--yes; rm -rf ~"] },
      { args: ["$(id)"] },
      { args: ["---x"] },
      { flags: { model: ["--model", "{model}", "|"] } },
      { flags: { effort: ["-c", "e=$({effort})"] } },
      { prompt: "argv" },
      { prompt: ["--prompt"] },
      { prompt: ["--prompt={brief}"] },
      { prompt: ["--prompt", BRIEF, BRIEF] },
    ]) {
      expect(() => catalogOf({ a: agent }), JSON.stringify(agent)).toThrow(/Invalid agent catalog \(test\)/);
    }
  });

  it("warns about a program two agents claim and ignores an executable alias that is taken", () => {
    const { catalog, warnings } = catalogOf({
      a: { exe: "tool", aliases: ["shared", "b", "tool"] },
      b: { exe: "tool", aliases: ["shared"] },
      c: { aliases: ["a-cli"] },
    });
    expect(warnings).toEqual([
      expect.stringMatching(/agents\.b\.exe: "tool" is a's program too; herdr finds a\./),
      expect.stringMatching(/agents\.a\.aliases: "b" is already b's, so it is ignored\./),
      expect.stringMatching(/agents\.b\.aliases: "shared" is already a's, so it is ignored\./),
    ]);
    expect(catalog.agents.a?.aliases).toEqual(["shared", "tool"]);
    expect(catalog.agents.b?.aliases).toEqual([]);
    expect(catalog.agents.c?.aliases).toEqual(["a-cli"]);
    expect(resolveAgent(catalog, "herdr", "tool")).toBe("a");
    expect(resolveAgent(catalog, "herdr", "shared")).toBe("a");
  });
});
