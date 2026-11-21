import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import type { Provider } from "../src/capabilities.js";
import { BRIEF, loadCatalog } from "../src/catalog.js";
import { runCli } from "../src/cliMain.js";
import { HERDR_PROBE, HERDR_PROBE_PROGRAMS, HERDR_SNIPPET, herdr, readProbe } from "../src/hosts/herdr.js";
import { hostContext, resolveHost } from "../src/hosts/index.js";
import { t3 } from "../src/hosts/t3.js";
import type { Launch } from "../src/hosts/types.js";
import type { Candidate, Recommendation } from "../src/recommend.js";
import { connectServer, defaultPolicy, driverFixtureRaw, resultText, tempDir } from "./helpers.js";

const T0 = new Date("2026-11-21T09:00:00Z");
const HOUR = 3_600_000;
const probe = (name: string) => readFileSync(new URL(`./fixtures/herdr/${name}.txt`, import.meta.url), "utf8");
const context = (home = tempDir(), platform: NodeJS.Platform = "darwin") =>
  hostContext(home, T0, defaultPolicy(), platform);
const HC = ["hc", "run", "--bg", "--name", "{name}", "--cwd", "{cwd}"];

type Result = Recommendation & {
  host?: string;
  capabilitiesFrom: string;
  capabilitiesAgeMinutes?: number;
  candidates: (Candidate & { launch?: Launch })[];
};

describe("the herdr probe", () => {
  it("reads the programs the probe found from their paths, in order", () => {
    expect(readProbe(probe("probe-macos"))).toEqual({
      names: ["claude", "grok", "opencode", "opencode2"],
      ignored: [],
    });
    expect(readProbe(probe("probe-linux")).names).toEqual(["claude", "codex", "cursor-agent", "agy", "kiro-cli"]);
    expect(readProbe(probe("probe-none"))).toEqual({ names: [], ignored: [] });
  });

  it("takes a shell alias by its name, and Windows paths and paths with spaces by their last part", () => {
    expect(readProbe(probe("probe-shell-alias")).names).toEqual(["claude", "codex"]);
    expect(readProbe("C:\\Users\\dev\\bin\\claude.exe\r\n/Users/Jane Doe/bin/codex\n").names).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("takes program names as text, as a list or as JSON text, without repeats", () => {
    expect(readProbe("claude codex, pi\ncodex").names).toEqual(["claude", "codex", "pi"]);
    expect(readProbe(["claude", " /usr/bin/codex ", "", "claude"]).names).toEqual(["claude", "codex"]);
    expect(readProbe('["claude", "codex"]').names).toEqual(["claude", "codex"]);
    expect(readProbe("[]").names).toEqual([]);
  });

  it("ignores what is not one safe word, and refuses other shapes", () => {
    expect(readProbe("claude\n$(id)\nfoo;bar\n/bin/a b").ignored).toEqual(["$(id)", "foo;bar", "/bin/a b"]);
    expect(readProbe(["-x", "claude"])).toEqual({ names: ["claude"], ignored: ["-x"] });
    expect(() => readProbe({ agents: ["claude"] })).toThrow(/^capabilities for herdr is the output of sh -c '/);
    expect(() => readProbe(["claude", 3])).toThrow(/got a list with an item that is not a string/);
    expect(() => readProbe(42)).toThrow(/got number\.$/);
  });

  it("is told apart from T3 Code's output, and the probe text from other text", () => {
    for (const payload of [probe("probe-macos"), probe("probe-shell-alias"), ["claude"], [], '["claude"]']) {
      expect(herdr.detect(payload), JSON.stringify(payload)).toBe(true);
    }
    const t3Output = driverFixtureRaw("mixed");
    for (const payload of [t3Output, JSON.stringify(t3Output), "claude codex", "{bad", "", "42", 42, null, [{}]]) {
      expect(herdr.detect(payload), JSON.stringify(payload)).toBe(false);
    }
  });

  it("lists the programs of the built-in catalog, and runs everywhere and exits 0", () => {
    const { catalog } = loadCatalog({ userPath: join(tempDir(), "missing.yaml") });
    const programs = Object.values(catalog.agents).flatMap((a) => [a.exe as string, ...(a.aliases ?? [])]);
    expect([...HERDR_PROBE_PROGRAMS]).toEqual(programs);
    expect(HERDR_PROBE).toBe(`sh -c 'for a in ${programs.join(" ")}; do command -v "$a"; done; true'`);
  });
});

describe("the host of a call with herdr's payload", () => {
  it("is herdr when the call names it, whatever the payload's form", () => {
    for (const payload of [probe("probe-macos"), "claude codex", ["claude"], [], '["claude"]']) {
      expect(resolveHost({ host: "herdr", payload })).toBe(herdr);
    }
  });

  it("must be named: the probe output alone asks for host, unless the last call was herdr's", () => {
    expect(() => resolveHost({ payload: probe("probe-linux") })).toThrow(
      'capabilities look like herdr output, but the call names no host: pass host: "herdr".',
    );
    expect(resolveHost({ payload: probe("probe-linux"), last: herdr })).toBe(herdr);
    // A list is T3's (a bare providers array) unless the call says otherwise; T3's adapter comes first.
    expect(resolveHost({ payload: ["claude"] })).toBe(t3);
  });

  it("refuses a payload of the other host", () => {
    expect(() => resolveHost({ host: "t3", payload: probe("probe-linux") })).toThrow(
      'host is "t3", but capabilities look like herdr output (host "herdr").',
    );
    expect(() => resolveHost({ host: "herdr", payload: driverFixtureRaw("mixed") })).toThrow(
      'host is "herdr", but capabilities look like T3 Code output (host "t3").',
    );
  });
});

describe("the herdr catalog", () => {
  const providers = (payload: unknown, home?: string) =>
    herdr.catalog({ capabilities: payload }, context(home)).capabilities.providers;
  const programs = (list: Provider[]) => list.map((p) => [p.providerInstanceId, p.program]);

  it("has one provider per agent found, keyed by the catalog's id, with the program to run", () => {
    const { capabilities, outputs, session, notes } = herdr.catalog(
      { capabilities: probe("probe-linux"), orchestrator: { agent: "claude", model: "opus" } },
      context(),
    );
    expect(programs(capabilities.providers)).toEqual([
      ["claude", "claude"],
      ["codex", "codex"],
      ["cursor", "cursor-agent"],
      ["antigravity", "agy"],
      ["kiro", "kiro-cli"],
    ]);
    expect(capabilities.providers[0]).toMatchObject({
      driverKind: "claudeAgent",
      displayName: "Claude Code",
      canRunChildTask: true,
      omittedModels: 0,
      models: [
        {
          id: "opus",
          policyFamily: "claude-opus",
          options: [{ id: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        },
        { id: "sonnet", policyFamily: "claude-sonnet" },
        { id: "haiku", policyFamily: "claude-haiku" },
        { id: "fable", policyFamily: "claude-fable" },
      ],
    });
    expect(capabilities).toMatchObject({ inheritedProviderInstanceId: "claude", inheritedModel: "opus" });
    expect(outputs).toBe(0);
    expect(session).toBeUndefined();
    expect(notes).toEqual([
      expect.stringMatching(
        /^No models are declared for antigravity and kiro in the agent catalog, so only their default model is offered/,
      ),
    ]);
  });

  it("runs the agent's exe when it is found too, and an executable alias when it is the only one", () => {
    expect(programs(providers(probe("probe-macos")))).toEqual([
      ["claude", "claude"],
      ["grok", "grok"],
      ["opencode", "opencode"],
    ]);
    expect(programs(providers(["opencode2", "cursor"]))).toEqual([
      ["opencode", "opencode2"],
      ["cursor", "cursor-agent"],
    ]);
  });

  it("offers an agent the catalog does not know with its default model only, and says how to describe it", () => {
    const { capabilities, notes } = herdr.catalog({ capabilities: ["goose", "my.tool", "claude"] }, context());
    expect(programs(capabilities.providers)).toEqual([
      ["goose", "goose"],
      ["claude", "claude"],
    ]);
    expect(capabilities.providers[0]?.models).toEqual([{ id: "default" }]);
    expect(notes).toEqual([
      '"my.tool": not an agent id, so ignored.',
      "goose is not in the agent catalog: offered with the default model only, started with no flags and sent the " +
        "brief once ready. Describe it in catalog.yaml (exe, models, flags, prompt) to do better.",
    ]);
  });

  it("names the orchestrator's agent as the catalog does, and ignores values that are not one word", () => {
    const build = (orchestrator: { agent: string; model?: string }) =>
      herdr.catalog({ capabilities: ["claude", "cursor-agent"], orchestrator }, context());
    expect(build({ agent: "cursor-agent", model: "auto" }).capabilities).toMatchObject({
      inheritedProviderInstanceId: "cursor",
      inheritedModel: "auto",
    });
    const odd = build({ agent: "claude code", model: "opus 4" });
    expect(odd.capabilities).toMatchObject({ inheritedProviderInstanceId: null, inheritedModel: null });
    expect(odd.notes).toEqual([
      'orchestrator.agent "claude code" is not a program name, so it is ignored.',
      'orchestrator.model "opus 4" is not one command-line word, so it is ignored.',
    ]);
  });

  it("follows the user's catalog.yaml and passes on its warnings and what the probe held that is not a program", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "catalog.yaml"),
      "agents:\n  claude: { models: [claude-opus-9-2, opus], colour: blue }\n  goose: { models: [default] }\n",
    );
    const { capabilities, notes } = herdr.catalog(
      { capabilities: "/usr/bin/claude\n/usr/bin/goose\n$(id)\n" },
      context(home),
    );
    expect(capabilities.providers.map((p) => p.models.map((m) => m.id))).toEqual([
      ["claude-opus-9-2", "opus"],
      ["default"],
    ]);
    expect(notes).toEqual([
      expect.stringMatching(/unknown key "colour" under agents\.claude is ignored/),
      expect.stringMatching(/^No models are declared for goose/),
      'Ignored in capabilities: "$(id)" (not a program path or name).',
    ]);
  });

  it("builds a catalog from catalog.yaml alone only when it lists herdr's agents", () => {
    expect(herdr.catalogFromFiles?.({}, context())).toBeUndefined();
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "hosts:\n  herdr:\n    agents: [claude, cursor-agent]\n");
    const built = herdr.catalogFromFiles?.({ orchestrator: { agent: "claude" } }, context(home));
    expect(programs(built?.capabilities.providers ?? [])).toEqual([
      ["claude", "claude"],
      ["cursor", "cursor-agent"],
    ]);
    expect(built?.capabilities.inheritedProviderInstanceId).toBe("claude");
  });

  it("rebuilds a kept catalog with the catalog in force and the call's orchestrator", () => {
    const kept = herdr.catalog(
      { capabilities: probe("probe-macos"), orchestrator: { agent: "claude", model: "opus" } },
      context(),
    ).capabilities;
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  opencode: { models: [anthropic/claude-opus-9-2] }\n");
    const fresh = herdr.refresh?.(kept, {}, context(home));
    expect(programs(fresh?.capabilities.providers ?? [])).toEqual(programs(kept.providers));
    expect(fresh?.capabilities.providers[2]?.models).toEqual([{ id: "anthropic/claude-opus-9-2" }]);
    expect(fresh?.capabilities).toMatchObject({ inheritedProviderInstanceId: "claude", inheritedModel: "opus" });
    expect(herdr.refresh?.(kept, { orchestrator: { agent: "grok" } }, context(home))?.capabilities).toMatchObject({
      inheritedProviderInstanceId: "grok",
      inheritedModel: null,
    });
  });
});

describe("the launch command for hc", () => {
  const ctx = context();
  const { capabilities } = herdr.catalog(
    { capabilities: [...readProbe(probe("probe-linux")).names, "grok", "opencode2", "pi", "muse", "goose"] },
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
  const launch = (c: Candidate, on = ctx) => herdr.launch?.(c, on, provider(c.providerInstanceId)) as Launch;

  it("puts the brief last for an agent that takes it at start", () => {
    expect(launch(candidate("claude", "opus", "high"))).toEqual({
      mode: "supervised",
      agent: "claude",
      model: "opus",
      effort: "high",
      args: ["claude", "--model", "opus", "--effort", "high"],
      argv: [...HC, "claude", "--model", "opus", "--effort", "high", BRIEF],
    });
    expect(launch(candidate("codex", "default", "xhigh"))).toEqual({
      mode: "supervised",
      agent: "codex",
      effort: "xhigh",
      args: ["codex", "--no-daemon", "-c", "model_reasoning_effort=xhigh"],
      argv: [...HC, "codex", "--no-daemon", "-c", "model_reasoning_effort=xhigh", BRIEF],
    });
  });

  it("keeps the words that carry the brief out of args", () => {
    expect(launch(candidate("grok", "default", "low"))).toMatchObject({
      args: ["grok", "--reasoning-effort", "low"],
      argv: [...HC, "grok", "--reasoning-effort", "low", "--", BRIEF],
    });
    expect(launch(candidate("opencode", "default"))).toMatchObject({
      args: ["opencode2"],
      argv: [...HC, "opencode2", "--prompt", BRIEF],
    });
    expect(launch(candidate("antigravity", "default"))).toMatchObject({
      args: ["agy"],
      argv: [...HC, "agy", "--prompt-interactive", BRIEF],
    });
  });

  it("starts an agent that takes no brief at start, then waits for it and sends the brief", () => {
    const then = [
      ["hc", "wait", "{name}"],
      ["hc", "send", "{name}", BRIEF],
    ];
    expect(launch(candidate("kiro", "default"))).toEqual({
      mode: "supervised",
      agent: "kiro",
      args: ["kiro-cli", "chat", "--tui"],
      argv: [...HC, "kiro-cli", "chat", "--tui"],
      then,
    });
    expect(launch(candidate("muse", "muse-spark-9", "max"))).toMatchObject({
      args: ["muse", "--model", "muse-spark-9", "--reasoning-effort", "max"],
      argv: [...HC, "muse", "--model", "muse-spark-9", "--reasoning-effort", "max"],
      then,
    });
    expect(launch(candidate("goose", "default"))).toEqual({
      mode: "supervised",
      agent: "goose",
      args: ["goose"],
      argv: [...HC, "goose"],
      then,
      notes: ["goose is not in the agent catalog: it starts with no flags and gets the brief once it is ready."],
    });
  });

  it("runs the program found: cursor-agent for Cursor", () => {
    expect(launch(candidate("cursor", "auto")).argv).toEqual([...HC, "cursor-agent", "--model", "auto", BRIEF]);
  });

  it("refuses a model the agent's command cannot carry, so the candidate is skipped", () => {
    expect(() => launch(candidate("opencode", "anthropic/claude-opus-9-2"))).toThrow(
      "opencode takes no model at start. Set agents.opencode.flags.model in catalog.yaml.",
    );
    expect(() => launch(candidate("goose", "goose-9"))).toThrow(
      "goose is not in the agent catalog, so it can only start with its default model.",
    );
    expect(() => launch(candidate("claude", "--dangerously-skip-permissions"))).toThrow(/is not one command-line word/);
    expect(() => launch(candidate("claude", "opus", "high; rm -rf ~"))).toThrow(/is not one command-line word/);
  });

  it("says which options it cannot pass, and that Windows is not covered", () => {
    expect(launch(candidate("claude", "opus", undefined, [{ id: "fastMode", value: true }])).notes).toEqual([
      "Not passed: fastMode; the agent catalog has no flag for it.",
    ]);
    expect(launch(candidate("claude", "opus"), context(tempDir(), "win32")).notes).toEqual([
      'herdr on Windows is not covered yet: "$(cat <file>)" for {brief} needs a POSIX shell.',
    ]);
  });
});

describe("recommend_model in herdr", () => {
  const recommend = async (client: Client, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
    return res;
  };
  const data = (res: object) => {
    expect((res as { isError?: boolean }).isError, resultText(res)).toBeFalsy();
    return (res as { structuredContent: Result }).structuredContent;
  };
  const ids = (r: Result) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
  const first = {
    host: "herdr",
    session: "t1",
    capabilities: probe("probe-linux"),
    orchestrator: { agent: "claude", model: "opus" },
  };

  it("recommends from the probe, with host and a launch on every candidate", async () => {
    const { client } = await connectServer(tempDir(), { now: () => T0 });
    const code = data(await recommend(client, first));
    expect(code.host).toBe("herdr");
    expect(code.capabilitiesFrom).toBe("call");
    expect(ids(code)).toEqual(["claude/opus", "codex/default", "claude/sonnet"]);
    expect(code.candidates[0]).toMatchObject({ sameAsOrchestrator: true, options: [{ id: "effort", value: "high" }] });
    expect(code.candidates[0]?.launch?.argv).toEqual([...HC, "claude", "--model", "opus", "--effort", "high", BRIEF]);
    for (const c of code.candidates) expect(c.launch?.argv.slice(0, HC.length)).toEqual(HC);
    // A review leaves the orchestrator's own agent for last.
    const review = data(await recommend(client, { host: "herdr", taskType: "review" }));
    expect(review.capabilitiesFrom).toBe("cache");
    expect(review.candidates[0]).toMatchObject({ providerInstanceId: "codex", model: "default" });
    expect(review.candidates[0]?.launch?.argv).toEqual([
      ...HC,
      "codex",
      "--no-daemon",
      "-c",
      "model_reasoning_effort=high",
      BRIEF,
    ]);
  });

  it("keeps the catalog per session on disk, apart from T3's, and rebuilds it with the catalog in force", async () => {
    const home = tempDir();
    data(await recommend((await connectServer(home, { now: () => T0 })).client, first));
    expect(existsSync(join(home, "capabilities-cache.herdr.json"))).toBe(true);
    expect(existsSync(join(home, "capabilities-cache.json"))).toBe(false);
    // The user declares a versioned Opus after the probe; the restarted server rebuilds the saved catalog with it.
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  claude: { models: [claude-opus-9-2, opus, sonnet] }\n");
    const { client } = await connectServer(home, { now: () => new Date(T0.getTime() + HOUR) });
    const after = data(await recommend(client, { host: "herdr", session: "t1" }));
    expect(after.capabilitiesFrom).toBe("disk-cache");
    expect(after.capabilitiesAgeMinutes).toBe(60);
    expect(ids(after)[0]).toBe("claude/claude-opus-9-2");
    expect(after.warnings[0]).toBe(
      "Capabilities from the disk cache (the server restarted): received 1 h ago by an orchestrator on claude / " +
        'opus. If that is not you, or a child cannot start or its model id is rejected, pass host: "herdr" and, ' +
        `as capabilities, the output of ${HERDR_PROBE}.`,
    );
    // Another session has nothing kept, and a T3 call never sees herdr's catalog.
    expect(resultText(await recommend(client, { host: "herdr", session: "t9" }))).toBe(herdr.text.noCatalog);
    expect(resultText(await recommend(client, { host: "t3" }))).toBe(t3.text.noCatalog);
  });

  it("uses the agents catalog.yaml lists when nothing is kept, never keeping them", async () => {
    const home = tempDir();
    const { client } = await connectServer(home, { now: () => T0 });
    expect(resultText(await recommend(client, { host: "herdr" }))).toBe(herdr.text.noCatalog);
    writeFileSync(join(home, "catalog.yaml"), "hosts:\n  herdr:\n    agents: [claude, codex]\n");
    const files = data(await recommend(client, { host: "herdr" }));
    expect(files.capabilitiesFrom).toBe("catalog");
    expect(files).not.toHaveProperty("capabilitiesAgeMinutes");
    expect(ids(files)).toEqual(["claude/opus", "codex/default", "claude/sonnet"]);
    // The call's orchestrator applies: a review leaves its agent for last.
    const review = data(
      await recommend(client, { host: "herdr", taskType: "review", orchestrator: { agent: "codex" } }),
    );
    expect(ids(review)[0]).toBe("claude/opus");
    expect(review.candidates.at(-1)?.reason).toMatch(/same provider as the orchestrator; demoted/);
    expect(existsSync(join(home, "capabilities-cache.herdr.json"))).toBe(false);
    writeFileSync(join(home, "catalog.yaml"), "hosts:\n  herdr:\n    agents: [codex]\n");
    expect(ids(data(await recommend(client, { host: "herdr" })))).toEqual(["codex/default"]);
  });

  it("skips a candidate it cannot start, and says why", async () => {
    const home = tempDir();
    writeFileSync(join(home, "catalog.yaml"), "agents:\n  opencode: { models: [anthropic/claude-opus-9-2] }\n");
    const { client } = await connectServer(home, { now: () => T0 });
    const res = data(await recommend(client, { host: "herdr", capabilities: ["opencode", "codex"] }));
    expect(ids(res)).toEqual(["codex/default"]);
    expect(res.skipped).toContain(
      "opencode/anthropic/claude-opus-9-2: opencode takes no model at start. Set agents.opencode.flags.model in " +
        "catalog.yaml.",
    );
  });

  it("reports what it cannot use: an empty probe, mergeCapabilities, an invalid catalog.yaml", async () => {
    const home = tempDir();
    const { client } = await connectServer(home, { now: () => T0 });
    expect(resultText(await recommend(client, { host: "herdr", capabilities: probe("probe-none") }))).toBe(
      herdr.text.noProviders,
    );
    const merged = data(await recommend(client, { ...first, mergeCapabilities: true }));
    expect(merged.warnings).toContain("mergeCapabilities is ignored: herdr sends its whole catalog in one output.");
    writeFileSync(join(home, "catalog.yaml"), 'agents:\n  claude: { models: ["opus; id"] }\n');
    expect(resultText(await recommend(client, first))).toMatch(
      new RegExp(`^Invalid agent catalog \\(${join(home, "catalog.yaml").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`),
    );
  });

  it("asks for host when the probe output comes without it", async () => {
    const { client } = await connectServer(tempDir(), { now: () => T0 });
    const { host: _host, ...nameless } = first;
    expect(resultText(await recommend(client, nameless))).toBe(
      'capabilities look like herdr output, but the call names no host: pass host: "herdr".',
    );
  });
});

describe("herdr's state stays apart from T3 Code's", () => {
  const t3Codex = driverFixtureRaw("codex");

  async function open(home = tempDir()) {
    const { client } = await connectServer(home, { now: () => T0 });
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, resultText(res)).toBeFalsy();
      return res.structuredContent as Record<string, unknown> & Result;
    };
    return { client, call, home };
  }

  it("a mark in one host does not demote the same id in the other", async () => {
    const { call } = await open();
    const t3Before = await call("recommend_model", { task: "x", taskType: "review", capabilities: t3Codex });
    const herdrArgs = { task: "x", taskType: "review", host: "herdr", capabilities: ["codex", "claude"] };
    const herdrBefore = await call("recommend_model", herdrArgs);
    expect(herdrBefore.candidates[0]?.providerInstanceId).toBe("codex");

    await call("mark_unavailable", { host: "herdr", providerInstanceId: "codex", reason: "weekly limit" });
    const t3After = await call("recommend_model", { task: "x", taskType: "review", host: "t3" });
    expect(t3After.candidates).toEqual(t3Before.candidates);
    const herdrAfter = await call("recommend_model", { task: "x", taskType: "review", host: "herdr" });
    expect(herdrAfter.candidates[0]?.providerInstanceId).toBe("claude");

    await call("mark_unavailable", { host: "herdr", providerInstanceId: "codex", clear: true });
    await call("mark_unavailable", { host: "t3", providerInstanceId: "codex", reason: "weekly limit" });
    const herdrAgain = await call("recommend_model", { task: "x", taskType: "review", host: "herdr" });
    expect(herdrAgain.candidates).toEqual(herdrBefore.candidates);
  });

  it("profiles are kept per host, and each host lists the other's apart", async () => {
    const { call, home } = await open();
    await call("recommend_model", { task: "x", host: "herdr", capabilities: ["codex"] });
    const saved = await call("set_subscription", {
      host: "herdr",
      providerInstanceId: "codex",
      plan: "ChatGPT Plus",
      quota: "tight",
    });
    expect(saved.subscriptions).toEqual({ codex: expect.objectContaining({ plan: "ChatGPT Plus" }) });
    expect(readFileSync(join(home, "subscriptions.yaml"), "utf8")).toMatch(/^ {2}herdr:codex:$/m);
    const fromT3 = await call("get_subscriptions", { host: "t3" });
    expect(fromT3.subscriptions).toEqual({});
    expect(fromT3.otherHosts).toEqual({ "herdr:codex": expect.objectContaining({ plan: "ChatGPT Plus" }) });
    const t3 = await call("recommend_model", { task: "x", host: "t3", capabilities: t3Codex });
    expect(t3.setupNeeded?.providers.map((p) => p.providerInstanceId)).toEqual(["codex"]);
    const herdrNext = await call("recommend_model", { task: "x", host: "herdr" });
    expect(herdrNext.setupNeeded).toBeUndefined();
  });

  it("the log keeps herdr's records under its prefix and its own host", async () => {
    const { call, home } = await open();
    const logged = await call("log_delegation", {
      host: "herdr",
      taskType: "code",
      providerInstanceId: "claude",
      model: "opus",
      childThreadId: "t7",
    });
    expect(logged.logged).toMatchObject({ providerInstanceId: "claude", host: "herdr", childThreadId: "t7" });
    const line = JSON.parse(readFileSync(join(home, "log.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ providerInstanceId: "herdr:claude", host: "herdr" });
    const stats = await call("get_stats", { host: "t3" });
    expect(stats.total).toMatchObject({ delegations: 0 });
  });
});

describe("snippet --host herdr", () => {
  async function run(...argv: string[]) {
    let out = "";
    let err = "";
    const code = await runCli(argv, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  }

  it("prints herdr's snippet, which docs/hosts/herdr.md shows word for word", async () => {
    expect(await run("snippet", "--host", "herdr")).toEqual({ code: 0, out: HERDR_SNIPPET, err: "" });
    const doc = readFileSync(new URL("../docs/hosts/herdr.md", import.meta.url), "utf8");
    expect(doc).toContain(`\`\`\`markdown\n${HERDR_SNIPPET}\`\`\``);
  });

  it("asks for host, session, the probe, the orchestrator, the launch and the report line", () => {
    expect(HERDR_SNIPPET).toContain('`host: "herdr"`');
    expect(HERDR_SNIPPET).toContain("`session` (your `$HC_TERMINAL_ID`)");
    expect(HERDR_SNIPPET).toContain(HERDR_PROBE);
    expect(HERDR_SNIPPET).toContain("as `orchestrator` your own `agent`");
    expect(HERDR_SNIPPET).toContain("`launch.argv`, one element per argument");
    expect(HERDR_SNIPPET).toContain('`{brief}` by `"$(cat <file>)"`');
    expect(HERDR_SNIPPET).toContain("`launch.then`");
    expect(HERDR_SNIPPET).toContain("Report with hc send $HC_TERMINAL_ID when done or stuck.");
    expect(HERDR_SNIPPET).toMatch(/never `echo` or a heredoc/);
  });
});
