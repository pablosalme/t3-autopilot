import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cliMain.js";
import {
  agentsWithoutModels,
  ORCA_DEFAULT_MODEL,
  orcaLaunch,
  orcaToCapabilities,
  readOrcaInput,
  readOrcaModels,
} from "../src/orca.js";
import { ORCA_INSTRUCTIONS_SNIPPET } from "../src/snippet.js";
import { connectServer, fixture, tempDir } from "./helpers.js";

/** Raw `orca agent installed --json` output (invented ids). */
function installed(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("./fixtures/orca/agent-installed.json", import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

const MODELS = {
  claude: ["claude-opus-9-2", "claude-sonnet-9-1", "claude-haiku-9-1"],
  codex: [{ id: "gpt-9.1-codex", efforts: ["low", "medium", "high"] }, "gpt-9.1-codex-mini"],
};

interface OrcaCandidate {
  providerInstanceId: string;
  model: string;
  sameAsOrchestrator: boolean;
  orca: { agent: string; model?: string; effort?: string; command: string };
}

describe("readOrcaInput", () => {
  it("reads the raw output of orca agent installed --json, as an object or a string", () => {
    const raw = installed();
    expect(readOrcaInput(raw)?.agents.map((a) => a.id)).toEqual(["claude", "codex", "cursor", "goose"]);
    expect(readOrcaInput(JSON.stringify(raw))?.agents).toHaveLength(4);
  });

  it("takes orchestrator and models next to result, or a bare agents list", () => {
    const input = readOrcaInput({ ...installed(), orchestrator: { agent: "claude", model: "claude-opus-9-2" } });
    expect(input?.orchestrator).toEqual({ agent: "claude", model: "claude-opus-9-2" });
    expect(readOrcaInput({ agents: [{ id: "codex" }], models: MODELS })?.models).toEqual(MODELS);
  });

  it("leaves T3 capabilities and other values alone", () => {
    expect(readOrcaInput(fixture())).toBeUndefined();
    expect(readOrcaInput("not json")).toBeUndefined();
    expect(readOrcaInput([1, 2])).toBeUndefined();
  });

  it("rejects an invalid Orca input", () => {
    expect(() => readOrcaInput({ agents: [{ name: "no id" }] })).toThrow(/Orca input/);
  });
});

describe("orcaToCapabilities", () => {
  it("maps agents to drivers, declared models to effort options, and the orchestrator", () => {
    const input = readOrcaInput({ ...installed(), orchestrator: { agent: "claude", model: "claude-opus-9-2" } });
    if (!input) throw new Error("no input");
    const caps = orcaToCapabilities(input, MODELS);
    expect(caps.host).toBe("orca");
    expect(caps.inheritedProviderInstanceId).toBe("claude");
    expect(caps.inheritedModel).toBe("claude-opus-9-2");
    const byId = Object.fromEntries(caps.providers.map((p) => [p.providerInstanceId, p]));
    expect(byId.claude?.driverKind).toBe("claudeAgent");
    expect(byId.goose?.driverKind).toBe("goose");
    expect(byId.claude?.models[0]).toEqual({
      id: "claude-opus-9-2",
      options: [{ id: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    });
    expect(byId.codex?.models[0]?.options).toEqual([{ id: "effort", values: ["low", "medium", "high"] }]);
    expect(byId.cursor?.models).toEqual([{ id: ORCA_DEFAULT_MODEL }]);
    expect(byId.goose?.canRunChildTask).toBe(true);
  });

  it("prefers the call's models over the file's, per agent", () => {
    const input = readOrcaInput({
      agents: [{ id: "claude" }, { id: "codex" }],
      models: { claude: ["claude-opus-9-3"] },
    });
    if (!input) throw new Error("no input");
    const caps = orcaToCapabilities(input, MODELS);
    expect(caps.providers.map((p) => p.models[0]?.id)).toEqual(["claude-opus-9-3", "gpt-9.1-codex"]);
    expect(agentsWithoutModels(input, {})).toEqual(["codex"]);
  });
});

describe("orcaLaunch", () => {
  it("builds the launch command, with --effort only when there is a model", () => {
    expect(
      orcaLaunch({ providerInstanceId: "codex", model: "gpt-9.1-codex", options: [{ id: "effort", value: "high" }] }),
    ).toEqual({
      agent: "codex",
      model: "gpt-9.1-codex",
      effort: "high",
      command: 'orca agent launch --agent codex --model gpt-9.1-codex --effort high --prompt "<task brief>" --json',
    });
    expect(
      orcaLaunch({
        providerInstanceId: "cursor",
        model: ORCA_DEFAULT_MODEL,
        options: [{ id: "effort", value: "high" }],
      }),
    ).toEqual({ agent: "cursor", command: 'orca agent launch --agent cursor --prompt "<task brief>" --json' });
  });
});

describe("readOrcaModels", () => {
  it("is empty without a file and rejects an invalid one", () => {
    const dir = tempDir();
    expect(readOrcaModels(join(dir, "orca-models.yaml"))).toEqual({});
    writeFileSync(join(dir, "bad.yaml"), "claude: not-a-list\n");
    expect(() => readOrcaModels(join(dir, "bad.yaml"))).toThrow(/not valid/);
  });
});

describe("recommend_model with Orca", () => {
  it("recommends from orca-models.yaml and returns launch commands", async () => {
    const home = tempDir();
    writeFileSync(
      join(home, "orca-models.yaml"),
      "claude: [claude-opus-9-2, claude-sonnet-9-1, claude-haiku-9-1]\n" +
        "codex:\n  - { id: gpt-9.1-codex, efforts: [low, medium, high] }\n",
    );
    const { client } = await connectServer(home);
    const capabilities = { ...installed(), orchestrator: { agent: "claude", model: "claude-opus-9-2" } };

    const review = await client.callTool({
      name: "recommend_model",
      arguments: { task: "Review the auth middleware PR", taskType: "review", capabilities },
    });
    expect(review.isError).toBeFalsy();
    const r = review.structuredContent as { host: string; candidates: OrcaCandidate[]; warnings: string[] };
    expect(r.host).toBe("orca");
    expect(r.candidates[0]).toMatchObject({ providerInstanceId: "codex", model: "gpt-9.1-codex" });
    expect(r.candidates[0]?.orca.command).toMatch(
      /^orca agent launch --agent codex --model gpt-9\.1-codex --effort \w+/,
    );
    expect(r.warnings.join("\n")).toMatch(/no models declared for cursor, goose/);

    // A later call reuses the kept capabilities and still returns Orca launches.
    const code = await client.callTool({
      name: "recommend_model",
      arguments: { task: "Implement the export endpoint", taskType: "code" },
    });
    const c = code.structuredContent as { candidates: OrcaCandidate[] };
    expect(c.candidates[0]).toMatchObject({
      providerInstanceId: "claude",
      model: "claude-opus-9-2",
      sameAsOrchestrator: true,
    });
    expect(c.candidates[0]?.orca.command).toContain("--agent claude --model claude-opus-9-2");
  });

  it("works with no declared models, launching each CLI's default", async () => {
    const { client } = await connectServer();
    const res = await client.callTool({
      name: "recommend_model",
      arguments: { task: "Implement the export endpoint", taskType: "code", capabilities: JSON.stringify(installed()) },
    });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as { candidates: OrcaCandidate[] };
    expect(data.candidates.length).toBeGreaterThan(0);
    for (const cand of data.candidates) {
      expect(cand.model).toBe(ORCA_DEFAULT_MODEL);
      expect(cand.orca.command).not.toContain("--model");
    }
  });

  it("leaves T3 results without Orca fields", async () => {
    const { client } = await connectServer();
    const res = await client.callTool({
      name: "recommend_model",
      arguments: { task: "Implement the export endpoint", capabilities: fixture() },
    });
    const data = res.structuredContent as Record<string, unknown> & { candidates: Record<string, unknown>[] };
    expect(data.host).toBeUndefined();
    expect(data.candidates[0]?.orca).toBeUndefined();
  });
});

describe("snippet --host orca", () => {
  it("prints the Orca snippet, and rejects an unknown host", async () => {
    let out = "";
    let err = "";
    const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
    expect(await runCli(["snippet", "--host", "orca"], io)).toBe(0);
    expect(out).toBe(ORCA_INSTRUCTIONS_SNIPPET);
    expect(await runCli(["snippet", "--host=nope"], io)).toBe(2);
    expect(err).toMatch(/Unknown host/);
  });
});
