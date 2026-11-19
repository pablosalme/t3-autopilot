import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autopilotHome, logPath, userPolicyPath } from "../src/paths.js";
import { loadPolicy } from "../src/policy.js";
import { tempDir } from "./helpers.js";

const saved = process.env.T3_AUTOPILOT_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.T3_AUTOPILOT_HOME;
  else process.env.T3_AUTOPILOT_HOME = saved;
});

describe("paths", () => {
  it("respects T3_AUTOPILOT_HOME", () => {
    const dir = tempDir();
    process.env.T3_AUTOPILOT_HOME = dir;
    expect(autopilotHome()).toBe(dir);
    expect(userPolicyPath()).toBe(join(dir, "policy.yaml"));
    expect(logPath()).toBe(join(dir, "log.jsonl"));
  });

  it("expands a leading ~ in T3_AUTOPILOT_HOME: an MCP config has no shell to do it", () => {
    // Paths are only computed here; nothing is read or written.
    process.env.T3_AUTOPILOT_HOME = "~/autopilot-work";
    expect(autopilotHome()).toBe(join(homedir(), "autopilot-work"));
    expect(logPath()).toBe(join(homedir(), "autopilot-work", "log.jsonl"));
    process.env.T3_AUTOPILOT_HOME = "~\\autopilot-work";
    expect(autopilotHome()).toBe(join(homedir(), "autopilot-work"));
    process.env.T3_AUTOPILOT_HOME = "~";
    expect(autopilotHome()).toBe(homedir());
    // Another user's home (~name) is left to the caller, as is any other path.
    process.env.T3_AUTOPILOT_HOME = "~name/data";
    expect(autopilotHome()).toBe("~name/data");
    process.env.T3_AUTOPILOT_HOME = "  ";
    expect(autopilotHome()).toBe(join(homedir(), ".t3-autopilot"));
  });
});

describe("loadPolicy", () => {
  it("loads the bundled default", () => {
    const { policy, sources } = loadPolicy({ userPath: join(tempDir(), "none.yaml") });
    expect(sources).toHaveLength(1);
    expect(Object.keys(policy.taskTypes)).toEqual(
      expect.arrayContaining(["code", "review", "research", "writing", "design", "quick", "plan", "debug"]),
    );
  });

  it("merges a user override: families and task types by key, null removes", () => {
    const dir = tempDir();
    process.env.T3_AUTOPILOT_HOME = dir;
    writeFileSync(
      userPolicyPath(),
      [
        "maxCandidates: 2",
        "usage:",
        "  thresholds: { weekly: 60 }",
        "families:",
        "  kimi:",
        "    match: { opencode: '^opencode/kimi-(\\d+)(?:\\.(\\d+))?$' }",
        "taskTypes:",
        "  design: null",
        "  quick:",
        "    keywords: [rename]",
        "    candidates:",
        "      - { provider: opencode, family: kimi }",
      ].join("\n"),
    );
    const { policy, sources } = loadPolicy();
    expect(sources).toHaveLength(2);
    expect(policy.maxCandidates).toBe(2);
    expect(policy.usage.thresholds).toMatchObject({ weekly: 60, session: 80 });
    expect(policy.families.kimi).toBeDefined();
    expect(policy.families["claude-opus"]).toBeDefined();
    expect(policy.taskTypes.design).toBeUndefined();
    expect(policy.taskTypes.quick!.candidates).toEqual([{ provider: "opencode", family: "kimi" }]);
    expect(policy.taskTypes.code).toBeDefined();
  });

  it("reports unknown families and bad regexes", () => {
    const dir = tempDir();
    const userPath = join(dir, "policy.yaml");
    writeFileSync(
      userPath,
      "families:\n  broken:\n    match: { cursor: '([' }\ntaskTypes:\n  code:\n    candidates:\n      - { provider: cursor, family: missing }\n",
    );
    expect(() => loadPolicy({ userPath })).toThrow(/invalid regex[\s\S]*unknown family "missing"/);
  });

  it("the bundled default has no unknown keys, with every level of the schema strict", () => {
    expect(loadPolicy({ userPath: join(tempDir(), "none.yaml") }).warnings).toEqual([]);
  });

  it("ignores unknown keys at any level and names each one in a warning", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(
      userPath,
      [
        "maxCandidatez: 1",
        "usage:",
        "  thresholdz: { weekly: 60 }",
        "  thresholds: { weekley: 60 }",
        "effortShift: { sizes: { small: -2 } }",
        "families:",
        "  kimi:",
        "    serach: kimi",
        "    match: { '*': '^kimi-(\\d+)$' }",
        "taskTypes:",
        "  quick:",
        "    keyword: [rename]",
        "    candidates:",
        "      - { provider: opencode, family: kimi }",
        "      - { provider: '*', family: kimi, efort: low, noDemot: true }",
        "fallback:",
        "  - { provider: '*', family: gpt, effrt: high }",
      ].join("\n"),
    );
    const { policy, warnings } = loadPolicy({ userPath });
    const where = (w: string) => /unknown key "([^"]+)" (at the top level|under \S+) is ignored/.exec(w)?.slice(1, 3);
    // One warning per key; their order is the validator's and means nothing.
    expect(warnings.map(where).sort()).toEqual(
      [
        ["maxCandidatez", "at the top level"],
        ["sizes", "under effortShift"],
        ["thresholdz", "under usage"],
        ["weekley", "under usage.thresholds"],
        ["serach", "under families.kimi"],
        ["keyword", "under taskTypes.quick"],
        ["efort", "under taskTypes.quick.candidates[1]"],
        ["noDemot", "under taskTypes.quick.candidates[1]"],
        ["effrt", "under fallback[0]"],
      ].sort(),
    );
    for (const w of warnings) expect(w).toContain(`Policy (${userPath}, on top of the default policy)`);
    // The misspelt keys change nothing; the rest of the file applies.
    expect(policy.maxCandidates).toBe(3);
    expect(policy.usage.thresholds).toMatchObject({ weekly: 75, session: 80 });
    expect(policy.effortShift.size).toEqual({ small: -1, medium: 0, large: 1 });
    expect(policy.families.kimi).toEqual({ match: { "*": "^kimi-(\\d+)$" } });
    expect(policy.taskTypes.quick).toEqual({
      keywords: [],
      candidates: [
        { provider: "opencode", family: "kimi" },
        { provider: "*", family: "kimi" },
      ],
    });
    expect(policy.fallback).toEqual([{ provider: "*", family: "gpt" }]);
    expect(policy).not.toHaveProperty("maxCandidatez");
  });

  it("an unknown key next to a real mistake is part of the error", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(userPath, "maxCandidatez: 2\nmaxCandidates: 7\n");
    expect(() => loadPolicy({ userPath })).toThrow(/Unrecognized key: "maxCandidatez"[\s\S]*→ at maxCandidates/);
    // A mistake hidden behind an unknown key is still an error once the key is dropped.
    writeFileSync(userPath, "taskTypes:\n  code:\n    candidates:\n      - { family: gpt, providr: codex }\n");
    expect(() => loadPolicy({ userPath })).toThrow(/needs `provider`/);
  });

  it("rejects a candidate without provider or instance", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(userPath, "taskTypes:\n  code:\n    candidates:\n      - { family: claude-opus }\n");
    expect(() => loadPolicy({ userPath })).toThrow(/provider/);
  });
});

describe("review regressions", () => {
  it("validates the exclude regex at load time (#13)", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(userPath, "families:\n  broken:\n    match: { '*': '^x$' }\n    exclude: '(['\n");
    expect(() => loadPolicy({ userPath })).toThrow(/families\.broken\.exclude: invalid regex/);
  });

  it("names the file when the YAML is broken (#19)", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(userPath, "taskTypes: [unclosed\n");
    expect(() => loadPolicy({ userPath })).toThrow(
      new RegExp(`${userPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}: cannot read policy YAML`),
    );
  });

  it("ignores a __proto__ key in an override", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(userPath, "taskTypes:\n  __proto__:\n    candidates: [{ provider: x, family: claude-opus }]\n");
    const { policy } = loadPolicy({ userPath });
    expect(Object.hasOwn(policy.taskTypes, "__proto__")).toBe(false);
    expect(policy.taskTypes.code).toBeDefined();
  });

  it("rejects numeric option values in a candidate (#14)", () => {
    const userPath = join(tempDir(), "policy.yaml");
    writeFileSync(
      userPath,
      "taskTypes:\n  code:\n    candidates:\n      - { provider: cursor, family: composer, options: { fastMode: 1 } }\n",
    );
    expect(() => loadPolicy({ userPath })).toThrow(/Invalid policy/);
  });
});
