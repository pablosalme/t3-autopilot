import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { CapabilitiesSchema, type Provider } from "../src/capabilities.js";
import { runCli } from "../src/cliMain.js";
import { herdr } from "../src/hosts/herdr.js";
import { allHostsSnippet, HOSTS, hostContext, resolveHost } from "../src/hosts/index.js";
import { BRIEF_FILE, ORCA_DISCOVERY, ORCA_MODEL_AGENTS, ORCA_SNIPPET, orca, readInstalled } from "../src/hosts/orca.js";
import { t3 } from "../src/hosts/t3.js";
import type { Launch } from "../src/hosts/types.js";
import type { Candidate, Recommendation } from "../src/recommend.js";
import { connectServer, defaultPolicy, driverFixtureRaw, resultText, tempDir } from "./helpers.js";

const T0 = new Date("2026-11-21T09:00:00Z");
const HOUR = 3_600_000;
const output = (name: string) => readFileSync(new URL(`./fixtures/orca/${name}.json`, import.meta.url), "utf8");
const installed = () => output("agent-installed");
const context = (home = tempDir(), platform: NodeJS.Platform = "darwin") =>
  hostContext(home, T0, defaultPolicy(), platform);
const WORKER = ["orca", "orchestration", "worker-start", "--environment", "local"];
/** The same command from a server, which runs on this machine's platform: `orca-ide` on Linux. */
const HERE = [process.platform === "linux" ? "orca-ide" : "orca", ...WORKER.slice(1)];
const TAIL = ["--worktree", "current", "--spec-file", BRIEF_FILE, "--json"];
const CLI_NOTE =
  "If ORCA_CLI_COMMAND is set, run its value in place of orca; in an Orca dev checkout (ORCA_DEV_REPO_ROOT set), " +
  "orca-dev.";

/**
 * A command of `launch` as the instructions (step 3) have the orchestrator's shell tool run it: one shell command,
 * each element in single quotes (a `'` written as `'\''`), the first element replaced by Orca's command and
 * `{briefFile}` by the brief file's path.
 */
function shellLine(argv: readonly string[], command: string, briefFile: string): string {
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
  return argv.map((word, i) => quote(i === 0 ? command : word === BRIEF_FILE ? briefFile : word)).join(" ");
}

type Result = Recommendation & {
  host?: string;
  capabilitiesFrom: string;
  capabilitiesAgeMinutes?: number;
  candidates: (Candidate & { launch?: Launch })[];
};

describe("orca agent installed --json", () => {
  it("reads the agents of Orca's output, in order, with Orca's names", () => {
    expect(readInstalled(installed())).toEqual({
      agents: [
        { id: "claude", name: "Claude" },
        { id: "codex", name: "Codex" },
        { id: "cursor", name: "Cursor" },
        { id: "opencode2", name: "OpenCode 2" },
        { id: "pi", name: "Pi" },
        { id: "gemini", name: "Gemini" },
        { id: "goose", name: "Goose" },
      ],
      ignored: [],
    });
    expect(readInstalled(output("agent-installed-none"))).toEqual({ agents: [], ignored: [] });
  });

  it("reads a real output of Orca 1.4.269 on macOS", () => {
    // test/fixtures/orca/agent-installed-macos.json: the output of a run on 2026-11-21, its two uuids replaced.
    expect(readInstalled(output("agent-installed-macos"))).toEqual({
      agents: [
        { id: "claude", name: "Claude" },
        { id: "opencode", name: "OpenCode" },
        { id: "opencode2", name: "OpenCode 2" },
        { id: "hermes", name: "Hermes" },
        { id: "grok", name: "Grok" },
      ],
      ignored: [],
    });
  });

  it("takes the output as an object or as JSON text, its result, or the list of agents", () => {
    const parsed = JSON.parse(installed()) as { result: { agents: unknown[] } };
    const ids = (payload: unknown) => readInstalled(payload).agents.map((a) => a.id);
    const all = ["claude", "codex", "cursor", "opencode2", "pi", "gemini", "goose"];
    for (const payload of [parsed, parsed.result, parsed.result.agents, JSON.stringify(parsed.result.agents)]) {
      expect(ids(payload)).toEqual(all);
    }
    expect(readInstalled([{ id: "codex" }, { id: " claude ", name: " " }, { id: "codex", name: "Codex" }])).toEqual({
      agents: [{ id: "codex" }, { id: "claude" }],
      ignored: [],
    });
  });

  it("ignores what is not an agent with an Orca id", () => {
    expect(
      readInstalled({ agents: [{ id: "claude" }, { id: "$(id)" }, { id: "a:b" }, "codex", { name: "x" }, 7] }),
    ).toEqual({
      agents: [{ id: "claude" }],
      ignored: ['"$(id)"', '"a:b"', '"codex"', '{"name":"x"}', "7"],
    });
    expect(readInstalled({ agents: [{ id: "x".repeat(80) }] }).ignored).toEqual([`"${"x".repeat(38)}…`]);
  });

  it("says why Orca's command failed, and what to pass for any other shape", () => {
    // Orca's real output when it is not running (the path anonymized).
    expect(() => readInstalled(output("agent-installed-error"))).toThrow(
      `${ORCA_DISCOVERY} failed with runtime_unavailable: Could not read Orca runtime metadata at ` +
        "/Users/jane/Library/Application Support/orca/orca-runtime.json. Start the Orca app first. Pass its output " +
        "once it succeeds.",
    );
    expect(() =>
      readInstalled({ ok: false, error: { code: "runtime_unavailable", message: " Busy...\nRetry later.\n" } }),
    ).toThrow(`${ORCA_DISCOVERY} failed with runtime_unavailable: Busy. Pass its output once it succeeds.`);
    expect(() => readInstalled({ ok: false })).toThrow(`${ORCA_DISCOVERY} failed with an error. Pass its output`);
    const what = `capabilities for Orca is the output of ${ORCA_DISCOVERY}, exactly as printed (or its list of agents); got`;
    expect(() => readInstalled("claude codex")).toThrow(`${what} text that is not JSON.`);
    expect(() => readInstalled({ ok: true, result: { agents: "claude" } })).toThrow(
      `${what} an object without result.agents.`,
    );
    expect(() => readInstalled(null)).toThrow(`${what} null.`);
    expect(() => readInstalled(42)).toThrow(`${what} number.`);
  });

  it("is told apart from T3 Code's and herdr's payloads", () => {
    const parsed = JSON.parse(installed()) as { result: { agents: unknown[] } };
    const error = JSON.parse(output("agent-installed-error")) as unknown;
    for (const payload of [
      installed(),
      parsed,
      parsed.result,
      parsed.result.agents,
      error,
      [],
      "[]",
      '[{"id":"pi"}]',
    ]) {
      expect(orca.detect(payload), JSON.stringify(payload).slice(0, 40)).toBe(true);
    }
    const t3Output = driverFixtureRaw("mixed");
    const probe = "/usr/local/bin/claude\n/usr/local/bin/codex\n";
    for (const payload of [
      t3Output,
      JSON.stringify(t3Output),
      t3Output.providers,
      probe,
      ["claude"],
      "{bad",
      42,
      null,
    ]) {
      expect(orca.detect(payload), JSON.stringify(payload).slice(0, 40)).toBe(false);
    }
    for (const payload of [{ foo: 1 }, [{}], [{ id: "claude", providerInstanceId: "claude" }], { ok: "yes" }]) {
      expect(orca.detect(payload), JSON.stringify(payload)).toBe(false);
    }
  });
});

describe("the host of a call with Orca's payload", () => {
  const parsed = JSON.parse(installed()) as { result: { agents: unknown[] } };

  it("is Orca when the call names it, and when it does not: Orca's output is told apart", () => {
    for (const payload of [installed(), parsed, parsed.result, parsed.result.agents, []]) {
      expect(resolveHost({ host: "orca", payload })).toBe(orca);
    }
    for (const payload of [installed(), parsed, parsed.result, parsed.result.agents]) {
      expect(resolveHost({ payload })).toBe(orca);
    }
    expect(resolveHost({ payload: output("agent-installed-error") })).toBe(orca);
  });

  it("leaves T3 Code's and herdr's payloads as they were", () => {
    const t3Output = driverFixtureRaw("mixed");
    for (const payload of [t3Output, t3Output.providers, [t3Output], [], "[]", [{}]]) {
      expect(resolveHost({ payload }), JSON.stringify(payload).slice(0, 40)).toBe(t3);
    }
    expect(() => resolveHost({ payload: ["claude", "codex"] })).toThrow(
      'capabilities look like herdr output, but the call names no host: pass host: "herdr".',
    );
    expect(resolveHost({ host: "herdr", payload: ["claude"] })).toBe(herdr);
  });

  it("never takes Orca's list of agents for T3 Code's providers", () => {
    // Every T3 provider has a providerInstanceId; an agent of Orca's list has an id instead.
    expect(t3.detect(parsed.result.agents)).toBe(false);
    expect(t3.detect(JSON.stringify(parsed.result.agents))).toBe(false);
    expect(t3.detect([{ id: "claude", providerInstanceId: "claude" }])).toBe(true);
  });

  it("refuses a payload of another host", () => {
    expect(() => resolveHost({ host: "t3", payload: installed() })).toThrow(
      'host is "t3", but capabilities look like Orca output (host "orca").',
    );
    expect(() => resolveHost({ host: "herdr", payload: parsed.result })).toThrow(
      'host is "herdr", but capabilities look like Orca output (host "orca").',
    );
    expect(() => resolveHost({ host: "orca", payload: driverFixtureRaw("mixed") })).toThrow(
      'host is "orca", but capabilities look like T3 Code output (host "t3").',
    );
    expect(() => resolveHost({ host: "orca", payload: ["claude", "codex"] })).toThrow(
      'host is "orca", but capabilities look like herdr output (host "herdr").',
    );
  });
});

describe("the Orca catalog", () => {
  const build = (payload: unknown, home?: string, orchestrator?: { agent: string; model?: string }) =>
    orca.catalog({ capabilities: payload, ...(orchestrator ? { orchestrator } : {}) }, context(home));
  const agents = (list: Provider[]) => list.map((p) => [p.providerInstanceId, p.agent]);
  const models = (list: Provider[]) => Object.fromEntries(list.map((p) => [p.providerInstanceId, p.models]));

  it("has one provider per agent, keyed by the catalog's id, with the id Orca's --agent takes", () => {
    const { capabilities, outputs, session, notes } = build(installed(), undefined, { agent: "claude", model: "opus" });
    expect(agents(capabilities.providers)).toEqual([
      ["claude", "claude"],
      ["codex", "codex"],
      ["cursor", "cursor"],
      ["opencode", "opencode2"],
      ["pi", "pi"],
      ["gemini", "gemini"],
      ["goose", "goose"],
    ]);
    expect(capabilities.providers.map((p) => p.displayName)).toEqual([
      "Claude Code",
      "Codex",
      "Cursor Agent",
      "OpenCode",
      "Pi",
      "Gemini CLI",
      "Goose",
    ]);
    expect(capabilities.providers.every((p) => p.canRunChildTask && p.omittedModels === 0)).toBe(true);
    expect(capabilities).toMatchObject({ inheritedProviderInstanceId: "claude", inheritedModel: "opus" });
    expect(outputs).toBe(0);
    expect(session).toBeUndefined();
    expect(notes).toEqual([
      "goose is not in the agent catalog: offered with its default model only, the one set in its own config. " +
        "Describe it in catalog.yaml (driver, models) to do better.",
      expect.stringMatching(
        /^No models are declared for pi in the agent catalog, so only its default model is offered/,
      ),
    ]);
  });

  it("offers the catalog's models with their efforts, and the default model with none: Orca needs --model for --effort", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    expect(models(build(installed()).capabilities.providers)).toEqual({
      claude: [
        { id: "opus", policyFamily: "claude-opus", options: [{ id: "effort", values: efforts }] },
        { id: "sonnet", policyFamily: "claude-sonnet", options: [{ id: "effort", values: efforts }] },
        { id: "haiku", policyFamily: "claude-haiku" },
        { id: "fable", policyFamily: "claude-fable", options: [{ id: "effort", values: efforts }] },
      ],
      // Codex's default carries the gpt family, but no effort: Orca passes one only with --model.
      codex: [{ id: "default", policyFamily: "gpt" }],
      cursor: [{ id: "auto" }],
      opencode: [{ id: "default" }],
      pi: [{ id: "default" }],
      gemini: [{ id: "default" }],
      goose: [{ id: "default" }],
    });
  });

  it("follows Orca's rules for models: no --model for agents that take none, provider/id for Pi", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "catalog.yaml"),
      "agents:\n" +
        "  opencode: { models: [anthropic/claude-opus-9-2] }\n" +
        "  pi: { models: [openai/gpt-9.1-sol, gpt-9.1-sol, sonnet] }\n" +
        "  gemini: { models: [gemini-9-pro] }\n" +
        "  codex: { models: [gpt-9.2-codex, { id: default, family: gpt, efforts: [high] }] }\n",
    );
    const { capabilities, notes } = build(installed(), home);
    const offered = models(capabilities.providers);
    // Orca's opencode2 takes no --model (only its opencode does), and Gemini none at all.
    expect(offered.opencode).toEqual([{ id: "default" }]);
    expect(offered.gemini).toEqual([{ id: "default" }]);
    expect(offered.pi?.map((m) => m.id)).toEqual(["openai/gpt-9.1-sol"]);
    expect(offered.codex).toEqual([
      { id: "gpt-9.2-codex", options: [{ id: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }] },
      { id: "default", policyFamily: "gpt" },
    ]);
    expect(notes).toEqual([
      expect.stringMatching(/^goose is not in the agent catalog/),
      "Orca starts opencode2 with the model set in its own config (worker-start takes no --model for it), so the " +
        "models the agent catalog lists are not offered.",
      'Orca starts Pi only with a provider/id model, such as openai/gpt-9.1-sol, so "gpt-9.1-sol" and "sonnet" ' +
        "are not offered.",
    ]);
    // Orca's own opencode id takes the models, and starts OpenCode when Orca has both.
    const both = build({ agents: [{ id: "opencode2" }, { id: "opencode" }] }, home).capabilities;
    expect(agents(both.providers)).toEqual([["opencode", "opencode"]]);
    expect(both.providers[0]?.models).toEqual([{ id: "anthropic/claude-opus-9-2" }]);
    // Pi with no model left is offered its default.
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  pi: { models: [gpt-9.1-sol] }\n");
    expect(build({ agents: [{ id: "pi" }] }, home).capabilities.providers[0]?.models).toEqual([{ id: "default" }]);
  });

  it("offers an agent the catalog does not know with its default model, under Orca's name for it", () => {
    const { capabilities, notes } = build({ agents: [{ id: "goose", name: "Goose" }, { id: "omp" }, { id: "x.y" }] });
    expect(capabilities.providers.map((p) => [p.providerInstanceId, p.displayName, p.driverKind])).toEqual([
      ["goose", "Goose", "goose"],
      ["omp", "omp", "omp"],
    ]);
    expect(notes).toEqual([
      "goose and omp are not in the agent catalog: offered with their default model only, the one set in their own " +
        "config. Describe them in catalog.yaml (driver, models) to do better.",
      'Ignored in capabilities: "x.y" (not an Orca agent id).',
    ]);
  });

  it("names the orchestrator's agent as the catalog does, and ignores values that are not one word", () => {
    expect(
      build(installed(), undefined, { agent: "opencode2", model: "anthropic/claude-opus-9-2" }).capabilities,
    ).toMatchObject({
      inheritedProviderInstanceId: "opencode",
      inheritedModel: "anthropic/claude-opus-9-2",
    });
    const odd = build({ agents: [{ id: "claude" }] }, undefined, { agent: "claude code", model: "opus 4" });
    expect(odd.capabilities).toMatchObject({ inheritedProviderInstanceId: null, inheritedModel: null });
    expect(odd.notes).toEqual([
      'orchestrator.agent "claude code" is not an Orca agent id, so it is ignored.',
      'orchestrator.model "opus 4" is not one command-line word, so it is ignored.',
    ]);
  });

  it("passes on the warnings of the user's catalog.yaml", () => {
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  claude: { models: [claude-opus-9-2, opus], colour: blue }\n");
    const { capabilities, notes } = build({ agents: [{ id: "claude" }] }, home);
    expect(capabilities.providers[0]?.models.map((m) => m.id)).toEqual(["claude-opus-9-2", "opus"]);
    expect(notes).toEqual([expect.stringMatching(/unknown key "colour" under agents\.claude is ignored/)]);
  });

  it("rebuilds a kept catalog with the catalog in force and the call's orchestrator", () => {
    const kept = build(installed(), undefined, { agent: "claude", model: "opus" }).capabilities;
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  pi: { models: [openai/gpt-9.1-sol] }\n");
    const fresh = orca.refresh?.(kept, {}, context(home));
    expect(agents(fresh?.capabilities.providers ?? [])).toEqual(agents(kept.providers));
    expect(fresh?.capabilities.providers.find((p) => p.providerInstanceId === "pi")?.models).toEqual([
      {
        id: "openai/gpt-9.1-sol",
        options: [{ id: "effort", values: ["minimal", "low", "medium", "high", "xhigh", "max"] }],
      },
    ]);
    expect(fresh?.capabilities.providers.at(-1)?.displayName).toBe("Goose");
    expect(fresh?.capabilities).toMatchObject({ inheritedProviderInstanceId: "claude", inheritedModel: "opus" });
    expect(orca.refresh?.(kept, { orchestrator: { agent: "codex" } }, context(home))?.capabilities).toMatchObject({
      inheritedProviderInstanceId: "codex",
      inheritedModel: null,
    });
  });
});

describe("the launch command for Orca", () => {
  const ctx = context();
  const { capabilities } = orca.catalog(
    {
      capabilities: {
        agents: [
          ...(JSON.parse(installed()) as { result: { agents: object[] } }).result.agents,
          { id: "kiro" },
          { id: "opencode" },
        ],
      },
    },
    ctx,
  );
  const provider = (id: string) => capabilities.providers.find((p) => p.providerInstanceId === id) as Provider;
  const candidate = (id: string, model: string, effort?: string, more: Candidate["options"] = []): Candidate => ({
    providerInstanceId: id,
    model,
    options: [...(effort ? [{ id: "effort", value: effort }] : []), ...more],
    reason: "test",
    source: "taskType",
    sameAsOrchestrator: false,
  });
  const launch = (c: Candidate, on = ctx, p = provider(c.providerInstanceId)) => orca.launch?.(c, on, p) as Launch;

  it("starts a supervised worker with the agent, model and effort, and the brief from a file", () => {
    expect(launch(candidate("claude", "opus", "high"))).toEqual({
      mode: "supervised",
      agent: "claude",
      model: "opus",
      effort: "high",
      args: ["--agent", "claude", "--model", "opus", "--effort", "high"],
      argv: [...WORKER, "--agent", "claude", "--model", "opus", "--effort", "high", ...TAIL],
      notes: [CLI_NOTE],
    });
    expect(launch(candidate("claude", "haiku")).argv).toEqual([
      ...WORKER,
      "--agent",
      "claude",
      "--model",
      "haiku",
      ...TAIL,
    ]);
    expect(launch(candidate("cursor", "auto")).args).toEqual(["--agent", "cursor", "--model", "auto"]);
  });

  it("starts the default model with no --model, so with no --effort, and says how to get one", () => {
    expect(launch(candidate("codex", "default"))).toEqual({
      mode: "supervised",
      agent: "codex",
      args: ["--agent", "codex"],
      argv: [...WORKER, "--agent", "codex", ...TAIL],
      notes: [
        "No --effort: Orca passes one only with --model. To set it, list codex's model ids under agents.codex.models " +
          "in catalog.yaml.",
        CLI_NOTE,
      ],
    });
    // An effort with the default model (which the catalog never offers) is dropped, never passed alone.
    const forced = launch(candidate("codex", "default", "high"));
    expect(forced).not.toHaveProperty("effort");
    expect(forced.args).toEqual(["--agent", "codex"]);
    // Agents without efforts get no such note, and one that takes no model in Orca is not told to list models.
    expect(launch(candidate("gemini", "default")).notes).toEqual([CLI_NOTE]);
    expect(launch(candidate("goose", "default")).notes).toEqual([CLI_NOTE]);
    expect(launch(candidate("kiro", "default", "high")).notes).toEqual([
      "No --effort: Orca passes one only with --model.",
      CLI_NOTE,
    ]);
  });

  it("passes Orca's id for the agent: opencode2 for OpenCode 2", () => {
    const two = orca.catalog({ capabilities: { agents: [{ id: "opencode2" }] } }, ctx).capabilities.providers[0];
    expect(launch(candidate("opencode", "default"), ctx, two as Provider).args).toEqual(["--agent", "opencode2"]);
    expect(launch(candidate("goose", "default")).args).toEqual(["--agent", "goose"]);
  });

  it("says OpenCode takes a model only in an existing worktree", () => {
    expect(launch(candidate("opencode", "anthropic/claude-opus-9-2")).notes).toEqual([
      "OpenCode takes a model only in a worktree that exists: keep --worktree current, or name an existing worktree, " +
        "never new-child or new-top-level.",
      CLI_NOTE,
    ]);
  });

  it("refuses a model Orca would refuse, so the candidate is skipped", () => {
    expect(() => launch(candidate("kiro", "kiro-9"))).toThrow(
      "Orca starts kiro with the model set in its own config: worker-start takes no --model for it.",
    );
    expect(() => launch(candidate("goose", "goose-9"))).toThrow(
      "Orca starts goose with the model set in its own config: worker-start takes no --model for it.",
    );
    const two = orca.catalog({ capabilities: { agents: [{ id: "opencode2" }] } }, ctx).capabilities.providers[0];
    expect(() => launch(candidate("opencode", "anthropic/claude-opus-9-2"), ctx, two as Provider)).toThrow(
      "Orca starts opencode2 with the model set in its own config",
    );
    expect(() => launch(candidate("pi", "gpt-9.1-sol"))).toThrow(
      "Orca starts pi only with a provider/id model, such as openai/gpt-9.1-sol.",
    );
    expect(() => launch(candidate("claude", "--dangerously-skip-permissions"))).toThrow(/is not one command-line word/);
    expect(() => launch(candidate("claude", "opus", "high; rm -rf ~"))).toThrow(/is not one command-line word/);
    const odd = { ...provider("claude"), agent: "claude code" } as Provider;
    expect(() => launch(candidate("claude", "opus"), ctx, odd)).toThrow('"claude code" is not an Orca agent id.');
  });

  it("runs orca-ide on Linux, and says what to quote with on Windows and which options it cannot pass", () => {
    const linux = launch(candidate("claude", "opus"), context(tempDir(), "linux"));
    expect(linux.argv[0]).toBe("orca-ide");
    expect(linux.notes).toEqual([CLI_NOTE.replace("in place of orca;", "in place of orca-ide;")]);
    const windows = launch(candidate("claude", "opus"), context(tempDir(), "win32"));
    expect(windows.argv[0]).toBe("orca");
    expect(windows.notes).toEqual([
      CLI_NOTE,
      "In PowerShell, write each element in single quotes, a ' in one as ''; in cmd.exe, in double quotes.",
    ]);
    expect(launch(candidate("claude", "opus", undefined, [{ id: "fastMode", value: true }])).notes).toEqual([
      "Not passed: fastMode; worker-start has no flag for it.",
      CLI_NOTE,
    ]);
  });

  it("only takes --model for the agents whose worker-start takes one in Orca", () => {
    expect([...ORCA_MODEL_AGENTS].sort()).toEqual(
      ["antigravity", "claude", "codebuddy", "codex", "cursor", "grok", "muse", "omp", "opencode", "pi"].sort(),
    );
  });

  // What the instructions have the orchestrator do, run for real through sh, with a stand-in for Orca's command.
  it.skipIf(process.platform === "win32")(
    "through a POSIX shell, hands Orca each element as one argument, and the brief reaches it through its file untouched",
    () => {
      const dir = tempDir();
      // Orca's command, as $ORCA_CLI_COMMAND gives it: an absolute path, here with a space and a quote in it.
      const bin = join(dir, "Orca's app", "bin");
      mkdirSync(bin, { recursive: true });
      const command = join(bin, "orca");
      // The stand-in writes the arguments it gets and the text of the --spec-file, as JSON, to the file $ORCA_ARGS,
      // and prints a receipt as worker-start --json does.
      writeFileSync(
        command,
        "#!/usr/bin/env node\n" +
          'const fs = require("node:fs");\n' +
          "const args = process.argv.slice(2);\n" +
          'const spec = fs.readFileSync(args[args.indexOf("--spec-file") + 1], "utf8");\n' +
          "fs.writeFileSync(process.env.ORCA_ARGS, JSON.stringify({ args, spec }));\n" +
          'console.log(JSON.stringify({ ok: true, result: { dispatchId: "dsp_test", state: "ready" } }));\n',
        { mode: 0o755 },
      );
      const folder = join(dir, `it's a "dir" $(touch pwned) \`touch pwned\` ;x`);
      mkdirSync(folder);
      const briefFile = join(folder, "brief $HOME 'it''s'.md");
      const brief =
        "Review the login.\nKeep $HOME, `touch pwned`, $(touch pwned), \"double\", 'single', a \\ and * as they are.\n" +
        "-- --json --agent codex\nReport with worker_done.\n";
      writeFileSync(briefFile, brief);
      const out = join(dir, "args.json");
      const run = (argv: readonly string[]) => {
        const printed = execFileSync("/bin/sh", ["-c", shellLine(argv, command, briefFile)], {
          cwd: dir,
          env: { ...process.env, ORCA_ARGS: out },
          encoding: "utf8",
        });
        return { ...(JSON.parse(readFileSync(out, "utf8")) as { args: string[]; spec: string }), printed };
      };
      for (const c of [candidate("claude", "opus", "high"), candidate("codex", "default")]) {
        const { argv } = launch(c);
        const got = run(argv);
        expect(got.args).toEqual(argv.slice(1).map((w) => (w === BRIEF_FILE ? briefFile : w)));
        expect(got.spec).toBe(brief);
        expect(JSON.parse(got.printed)).toMatchObject({ ok: true, result: { dispatchId: "dsp_test" } });
      }
      // Nothing in the folder's name, the file's name or the brief ran.
      expect(readdirSync(dir).filter((f) => f.startsWith("pwned"))).toEqual([]);
      expect(readdirSync(folder)).toEqual([expect.stringMatching(/^brief /)]);
    },
  );
});

describe("recommend_model in Orca", () => {
  const recommend = (client: Client, args: Record<string, unknown>) =>
    client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
  const data = (res: object) => {
    expect((res as { isError?: boolean }).isError, resultText(res)).toBeFalsy();
    return (res as { structuredContent: Result }).structuredContent;
  };
  const ids = (r: Result) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
  const first = {
    host: "orca",
    session: "term_1",
    capabilities: installed(),
    orchestrator: { agent: "claude", model: "opus" },
  };

  it("recommends from Orca's agents, with host and a worker-start on every candidate", async () => {
    const { client } = await connectServer(tempDir(), { now: () => T0 });
    const code = data(await recommend(client, first));
    expect(code.host).toBe("orca");
    expect(code.capabilitiesFrom).toBe("call");
    expect(ids(code)).toEqual(["claude/opus", "codex/default", "claude/sonnet"]);
    expect(code.candidates[0]).toMatchObject({ sameAsOrchestrator: true, options: [{ id: "effort", value: "high" }] });
    expect(code.candidates[0]?.launch?.argv).toEqual([
      ...HERE,
      "--agent",
      "claude",
      "--model",
      "opus",
      "--effort",
      "high",
      ...TAIL,
    ]);
    for (const c of code.candidates) expect(c.launch?.argv.slice(0, HERE.length)).toEqual(HERE);
    // A review leaves the orchestrator's own agent for last; Codex's default model goes with no effort.
    const review = data(await recommend(client, { host: "orca", taskType: "review" }));
    expect(review.capabilitiesFrom).toBe("cache");
    expect(review.candidates[0]).toMatchObject({ providerInstanceId: "codex", model: "default", options: [] });
    expect(review.candidates[0]?.reason).toBe(
      "review #1: latest gpt on codex is default (model has no effort option; using its default)",
    );
    expect(review.candidates[0]?.launch?.argv).toEqual([...HERE, "--agent", "codex", ...TAIL]);
    // A quick task: Haiku, which takes no effort.
    const quick = data(await recommend(client, { host: "orca", taskType: "quick" }));
    expect(quick.candidates[0]?.launch?.args).toEqual(["--agent", "claude", "--model", "haiku"]);
  });

  it("recommends from a real output of Orca on macOS", async () => {
    const { client } = await connectServer(tempDir(), { now: () => T0 });
    const real = { host: "orca", capabilities: output("agent-installed-macos"), orchestrator: { agent: "claude" } };
    const args = (r: Result) => r.candidates.map((c: Candidate & { launch?: Launch }) => c.launch?.args.join(" "));
    expect(args(data(await recommend(client, real)))).toEqual([
      "--agent claude --model opus --effort high",
      "--agent grok",
      "--agent claude --model sonnet --effort high",
    ]);
    // Orca has OpenCode twice (opencode and opencode2): one provider, started as opencode, which takes a model.
    const review = data(await recommend(client, { ...real, taskType: "review" }));
    expect(args(review)).toEqual(["--agent grok", "--agent opencode", "--agent hermes"]);
  });

  it("finds Orca's output without host, since nothing else looks like it", async () => {
    const { client } = await connectServer(tempDir(), { now: () => T0 });
    const { host: _host, ...nameless } = first;
    const res = data(await recommend(client, nameless));
    expect(res.host).toBe("orca");
    expect(ids(res)[0]).toBe("claude/opus");
  });

  it("keeps the catalog per session on disk, apart from T3's, and rebuilds it with the catalog in force", async () => {
    const home = tempDir();
    data(await recommend((await connectServer(home, { now: () => T0 })).client, first));
    expect(existsSync(join(home, "capabilities-cache.orca.json"))).toBe(true);
    expect(existsSync(join(home, "capabilities-cache.json"))).toBe(false);
    // The user declares a versioned Opus after the first call; the restarted server rebuilds the saved catalog with it.
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  claude: { models: [claude-opus-9-2, opus, sonnet] }\n");
    const { client } = await connectServer(home, { now: () => new Date(T0.getTime() + HOUR) });
    const after = data(await recommend(client, { host: "orca", session: "term_1" }));
    expect(after.capabilitiesFrom).toBe("disk-cache");
    expect(after.capabilitiesAgeMinutes).toBe(60);
    expect(ids(after)[0]).toBe("claude/claude-opus-9-2");
    // The warning says what to run in Orca, never T3 Code's orchestrator_capabilities.
    expect(after.warnings[0]).toBe(
      "Capabilities from the disk cache (the server restarted): received 1 h ago by an orchestrator on claude / " +
        'opus. If that is not you, or a child cannot start or its model id is rejected, pass host: "orca" and, ' +
        `as capabilities, the output of ${ORCA_DISCOVERY}.`,
    );
    expect(after.warnings.join("\n")).not.toMatch(/orchestrator_capabilities/);
    // Another session has nothing kept, and a T3 call never sees Orca's catalog.
    expect(resultText(await recommend(client, { host: "orca", session: "term_9" }))).toBe(orca.text.noCatalog);
    expect(resultText(await recommend(client, { host: "t3" }))).toBe(t3.text.noCatalog);
  });

  it("asks for Orca's output when nothing is kept, and says why it cannot use one", async () => {
    const home = tempDir();
    const { client } = await connectServer(home, { now: () => T0 });
    expect(resultText(await recommend(client, { host: "orca" }))).toBe(
      `No Orca catalog yet: pass host: "orca" and, as \`capabilities\`, the output of \`${ORCA_DISCOVERY}\` (later ` +
        "calls can omit it).",
    );
    expect(resultText(await recommend(client, { host: "orca", capabilities: output("agent-installed-none") }))).toBe(
      orca.text.noProviders,
    );
    expect(
      resultText(await recommend(client, { host: "orca", capabilities: output("agent-installed-error") })),
    ).toMatch(/^orca agent installed --environment local --json failed with runtime_unavailable: /);
    const merged = data(await recommend(client, { ...first, mergeCapabilities: true }));
    expect(merged.warnings).toContain("mergeCapabilities is ignored: Orca sends its whole catalog in one output.");
    writeFileSync(join(home, "catalog.yaml"), 'agents:\n  claude: { models: ["opus; id"] }\n');
    expect(resultText(await recommend(client, first))).toMatch(/^Invalid agent catalog \(/);
  });

  it("skips a candidate Orca would refuse, and says why", async () => {
    // With no generic fallback, the orchestrator's own model is the last resort: Gemini, which takes no --model.
    const home = tempDir();
    writeFileSync(join(home, "policy.yaml"), "genericFallback: false\n");
    const { client } = await connectServer(home, { now: () => T0 });
    const res = data(
      await recommend(client, {
        host: "orca",
        capabilities: { agents: [{ id: "gemini" }] },
        orchestrator: { agent: "gemini", model: "gemini-9-pro" },
      }),
    );
    expect(res.candidates).toEqual([]);
    expect(res.skipped).toContain(
      "gemini/gemini-9-pro: Orca starts gemini with the model set in its own config: worker-start takes no --model " +
        "for it.",
    );
  });
});

describe("Orca's state stays apart from T3 Code's and herdr's", () => {
  async function open(home = tempDir()) {
    const { client } = await connectServer(home, { now: () => T0 });
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, resultText(res)).toBeFalsy();
      return res.structuredContent as Record<string, unknown> & Result;
    };
    return { call, home };
  }
  const review = { task: "x", taskType: "review" };

  it("a mark in Orca does not demote the same id in T3 Code or herdr, and theirs do not demote Orca's", async () => {
    const { call } = await open();
    const t3Before = await call("recommend_model", { ...review, capabilities: driverFixtureRaw("codex") });
    const herdrBefore = await call("recommend_model", { ...review, host: "herdr", capabilities: ["codex", "claude"] });
    const orcaArgs = { ...review, host: "orca", capabilities: { agents: [{ id: "codex" }, { id: "claude" }] } };
    const orcaBefore = await call("recommend_model", orcaArgs);
    expect(orcaBefore.candidates[0]?.providerInstanceId).toBe("codex");

    await call("mark_unavailable", { host: "orca", providerInstanceId: "codex", reason: "weekly limit" });
    expect((await call("recommend_model", { ...review, host: "t3" })).candidates).toEqual(t3Before.candidates);
    expect((await call("recommend_model", { ...review, host: "herdr" })).candidates).toEqual(herdrBefore.candidates);
    const orcaAfter = await call("recommend_model", { ...review, host: "orca" });
    expect(orcaAfter.candidates[0]?.providerInstanceId).toBe("claude");

    await call("mark_unavailable", { host: "orca", providerInstanceId: "codex", clear: true });
    await call("mark_unavailable", { host: "t3", providerInstanceId: "codex", reason: "weekly limit" });
    await call("mark_unavailable", { host: "herdr", providerInstanceId: "codex", reason: "weekly limit" });
    expect((await call("recommend_model", { ...review, host: "orca" })).candidates).toEqual(orcaBefore.candidates);
  });

  it("a quotaPool shared with T3 Code carries a mark across, as the user declared it", async () => {
    const { call } = await open();
    await call("recommend_model", { ...review, capabilities: driverFixtureRaw("codex") });
    await call("recommend_model", {
      ...review,
      host: "orca",
      capabilities: { agents: [{ id: "codex" }, { id: "claude" }] },
    });
    for (const host of ["t3", "orca"]) {
      await call("set_subscription", {
        host,
        providerInstanceId: "codex",
        plan: "ChatGPT Plus",
        quota: "standard",
        quotaPool: "chatgpt",
      });
    }
    await call("mark_unavailable", { host: "t3", providerInstanceId: "codex", reason: "weekly limit" });
    const after = await call("recommend_model", { ...review, host: "orca" });
    expect(after.candidates[0]?.providerInstanceId).toBe("claude");
    expect(after.candidates.find((c) => c.providerInstanceId === "codex")?.reason).toMatch(
      /shares quota pool "chatgpt" with t3:codex, marked unavailable/,
    );
  });

  it("profiles and log records are kept under Orca's prefix, and each host lists the others apart", async () => {
    const { call, home } = await open();
    await call("recommend_model", { task: "x", host: "orca", capabilities: { agents: [{ id: "codex" }] } });
    const saved = await call("set_subscription", {
      host: "orca",
      providerInstanceId: "codex",
      plan: "ChatGPT Plus",
      quota: "tight",
    });
    expect(saved.subscriptions).toEqual({ codex: expect.objectContaining({ plan: "ChatGPT Plus" }) });
    expect(readFileSync(join(home, "subscriptions.yaml"), "utf8")).toMatch(/^ {2}orca:codex:$/m);
    const fromT3 = await call("get_subscriptions", { host: "t3" });
    expect(fromT3.subscriptions).toEqual({});
    expect(fromT3.otherHosts).toEqual({ "orca:codex": expect.objectContaining({ plan: "ChatGPT Plus" }) });

    const logged = await call("log_delegation", {
      host: "orca",
      taskType: "code",
      providerInstanceId: "codex",
      model: "default",
      recommendedRank: 1,
      childThreadId: "dsp_7f3a",
    });
    expect(logged.logged).toMatchObject({ providerInstanceId: "codex", host: "orca", childThreadId: "dsp_7f3a" });
    const line = JSON.parse(readFileSync(join(home, "log.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ providerInstanceId: "orca:codex", host: "orca" });
    const outcome = await call("log_outcome", { host: "orca", delegationId: logged.delegationId, outcome: "success" });
    expect(outcome.logged).toMatchObject({ outcome: "success" });
    expect((await call("get_stats", { host: "t3" })).total).toMatchObject({ delegations: 0 });
    expect((await call("get_stats", { host: "orca" })).byModel).toHaveProperty(["orca:codex/default"]);
  });
});

describe("Orca's adapter at the edges", () => {
  const candidate = (id: string, model: string, options: Candidate["options"] = []): Candidate => ({
    providerInstanceId: id,
    model,
    options,
    reason: "test",
    source: "taskType",
    sameAsOrchestrator: false,
  });

  it("rebuilds a kept catalog that lacks Orca's fields, and keeps the orchestrator's options", () => {
    const kept = CapabilitiesSchema.parse({
      inheritedProviderInstanceId: "claude",
      inheritedModel: null,
      inheritedOptions: [{ id: "effort", value: "high" }],
      providers: [{ providerInstanceId: "claude", models: [], canRunChildTask: true }],
    });
    const fresh = orca.refresh?.(kept, {}, context());
    expect(fresh?.capabilities.providers.map((p) => [p.providerInstanceId, p.agent, p.displayName])).toEqual([
      ["claude", "claude", "Claude Code"],
    ]);
    expect(fresh?.capabilities).toMatchObject({
      inheritedProviderInstanceId: "claude",
      inheritedModel: null,
      inheritedOptions: [{ id: "effort", value: "high" }],
    });
  });

  it("names an orchestrator the catalog does not know by Orca's id, and says it for several agents at once", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "catalog.yaml"),
      "agents:\n  goose: { models: [goose-9] }\n  opencode: { models: [a/b] }\n",
    );
    const built = orca.catalog(
      {
        capabilities: { agents: [{ id: "goose" }, { id: "opencode2" }, undefined] },
        orchestrator: { agent: "hermes" },
      },
      context(home),
    );
    expect(built.capabilities.inheritedProviderInstanceId).toBe("hermes");
    expect(built.notes).toEqual([
      "Orca starts goose and opencode2 with the model set in their own config (worker-start takes no --model for " +
        "them), so the models the agent catalog lists are not offered.",
      "Ignored in capabilities: undefined (not an Orca agent id).",
    ]);
  });

  it("starts a provider saved without Orca's id with its own id, and names every option it cannot pass", () => {
    const ctx = context();
    const bare = { providerInstanceId: "claude", models: [{ id: "opus" }], canRunChildTask: true } as Provider;
    const two = [
      { id: "fastMode", value: true },
      { id: "thinking", value: true },
    ];
    const started = orca.launch?.(candidate("claude", "opus", two), ctx, bare) as Launch;
    expect(started.args).toEqual(["--agent", "claude", "--model", "opus"]);
    expect(started.notes).toEqual(["Not passed: fastMode and thinking; worker-start has no flag for them.", CLI_NOTE]);
  });
});

describe("snippet --host orca", () => {
  const doc = () => readFileSync(new URL("../docs/hosts/orca.md", import.meta.url), "utf8");
  async function run(...argv: string[]) {
    let out = "";
    let err = "";
    const code = await runCli(argv, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  }

  it("prints Orca's snippet, which docs/hosts/orca.md shows word for word", async () => {
    expect(await run("snippet", "--host", "orca")).toEqual({ code: 0, out: ORCA_SNIPPET, err: "" });
    expect(doc()).toContain(`\`\`\`markdown\n${ORCA_SNIPPET}\`\`\``);
  });

  it("is in snippet --host all, after T3 Code's and herdr's, with how to tell Orca apart", async () => {
    const all = await run("snippet", "--host", "all");
    expect(all.out).toBe(allHostsSnippet(HOSTS));
    expect(all.out).toContain(
      "- Orca: `ORCA_TERMINAL_HANDLE` or `ORCA_AGENT_SESSION_ID` is set in your environment (you run in an Orca " +
        "terminal or chat).",
    );
    const at = ["### T3 Code", "### herdr", "### Orca"].map((h) => all.out.indexOf(`\n${h}\n`));
    expect(at.every((n, i) => n > 0 && (i === 0 || n > (at[i - 1] ?? 0)))).toBe(true);
    expect(all.out.endsWith(ORCA_SNIPPET.slice(ORCA_SNIPPET.indexOf("\n\n") + 2))).toBe(true);
  });

  it("authorizes switching over the Orca skills, and asks for host, session, the agents and the orchestrator", () => {
    expect(ORCA_SNIPPET).toContain(
      "these steps take precedence over the Orca skills where they differ, such as their rule to add `--model` only " +
        "when the user named one",
    );
    expect(ORCA_SNIPPET).toContain('`host: "orca"`');
    expect(ORCA_SNIPPET).toContain(
      "`session` (the value of `$ORCA_TERMINAL_HANDLE`, or of `$ORCA_AGENT_SESSION_ID` in an Orca chat)",
    );
    expect(ORCA_SNIPPET).toContain(`the output of \`${ORCA_DISCOVERY}\`, exactly as printed`);
    expect(ORCA_SNIPPET).toContain("as `orchestrator` your own Orca `agent` id");
    expect(ORCA_SNIPPET).toMatch(/never `echo` or a heredoc/);
  });

  it("gives Orca's rule for its command, never bare orca on Linux", () => {
    expect(ORCA_SNIPPET).toContain(
      "Orca's command is `$ORCA_CLI_COMMAND` if that is set, else `orca-dev` if `$ORCA_DEV_REPO_ROOT` is set, else " +
        "`orca-ide` on Linux and `orca` elsewhere",
    );
  });

  it("runs launch.argv as one shell command, each element in single quotes, with an example of that rule", () => {
    expect(ORCA_SNIPPET).toContain("Run its `launch.argv` as one shell command, each element in single quotes");
    expect(ORCA_SNIPPET).toContain("a `'` in a path is written `'\\''`");
    // The examples are what that rule makes of a launch command.
    const ctx = context();
    const providers = orca.catalog({ capabilities: { agents: [{ id: "codex" }, { id: "claude" }] } }, ctx).capabilities
      .providers;
    const start = (id: string, model: string, effort?: string) =>
      orca.launch?.(
        {
          providerInstanceId: id,
          model,
          options: effort ? [{ id: "effort", value: effort }] : [],
          reason: "",
          source: "taskType",
          sameAsOrchestrator: false,
        },
        ctx,
        providers.find((p) => p.providerInstanceId === id) as Provider,
      ) as Launch;
    expect(ORCA_SNIPPET).toContain(
      `For example: \`${shellLine(start("codex", "default").argv, "orca", "/tmp/review-auth.md")}\`.`,
    );
    expect(doc()).toContain(
      `\`\`\`sh\n   ${shellLine(start("claude", "opus", "high").argv, "orca", "/tmp/fix-login.md")}\n   \`\`\``,
    );
  });

  it("has the orchestrator end its turn, log the dispatchId and read the result when worker_done arrives", () => {
    expect(ORCA_SNIPPET).toContain(
      "Then end your turn: Orca wakes you when the worker reports with `worker_done`, asks or stops; never poll.",
    );
    expect(ORCA_SNIPPET).toContain("`childThreadId` (the `dispatchId` that `worker-start` printed)");
    expect(ORCA_SNIPPET).toContain("`orca orchestration worker-read --dispatch <dispatchId>`");
    expect(ORCA_SNIPPET).toContain('call `mark_unavailable` with `host: "orca"`');
  });
});
