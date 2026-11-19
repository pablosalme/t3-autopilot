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
