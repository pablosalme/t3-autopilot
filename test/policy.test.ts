import { writeFileSync } from "node:fs";
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
