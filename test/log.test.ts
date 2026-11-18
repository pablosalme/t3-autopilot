import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeStats, logDelegation, logOutcome, readLog } from "../src/log.js";
import { tempDir } from "./helpers.js";

const newLog = () => join(tempDir(), "nested", "log.jsonl");

describe("delegation log", () => {
  it("appends delegations and outcomes as JSONL and creates the directory", () => {
    const path = newLog();
    const d = logDelegation(path, { taskType: "code", providerInstanceId: "codex", model: "gpt-6.2-codex", recommendedRank: 1 });
    expect(d.id).toMatch(/^d_[0-9a-f]{12}$/);
    logOutcome(path, { delegationId: d.id, outcome: "success", note: "accepted" });
    const records = readLog(path);
    expect(records.map((r) => r.kind)).toEqual(["delegation", "outcome"]);
  });

  it("truncates summaries", () => {
    const d = logDelegation(newLog(), { taskType: "code", providerInstanceId: "a", model: "m", summary: "x".repeat(500) });
    expect(d.summary!.length).toBe(200);
  });

  it("accepts a standalone outcome and rejects an unknown delegationId", () => {
    const path = newLog();
    logOutcome(path, { taskType: "review", providerInstanceId: "cursor", model: "gemini-5.1-pro", outcome: "corrected" });
    expect(() => logOutcome(path, { delegationId: "d_nope", outcome: "success" })).toThrow(/Unknown delegationId/);
    expect(() => logOutcome(path, { outcome: "success" })).toThrow(/needs delegationId/);
  });

  it("summarises by task type and model; the last outcome wins", () => {
    const path = newLog();
    const a = logDelegation(path, { taskType: "code", providerInstanceId: "claudeAgent", model: "claude-opus-7-1", recommendedRank: 1 });
    logOutcome(path, { delegationId: a.id, outcome: "failure" });
    logOutcome(path, { delegationId: a.id, outcome: "success" });
    const b = logDelegation(path, { taskType: "code", providerInstanceId: "codex", model: "gpt-6.2-codex", recommendedRank: 2 });
    logOutcome(path, { delegationId: b.id, outcome: "corrected" });
    logDelegation(path, { taskType: "code", providerInstanceId: "codex", model: "gpt-6.2-codex", recommendedRank: null });
    logOutcome(path, { taskType: "review", providerInstanceId: "cursor", model: "gemini-5.1-pro", outcome: "success" });
    appendFileSync(path, "{not json\n");

    const s = computeStats(readLog(path));
    expect(s.total).toMatchObject({ delegations: 4, success: 2, corrected: 1, failure: 0, pending: 1, successRate: 0.667 });
    expect(s.byTaskType.code).toMatchObject({ delegations: 3, success: 1, corrected: 1, pending: 1 });
    expect(s.byTaskType.code!.byModel["codex/gpt-6.2-codex"]).toMatchObject({ delegations: 2, corrected: 1, pending: 1, successRate: 0 });
    expect(s.byTaskType.review!.byModel["cursor/gemini-5.1-pro"]).toMatchObject({ success: 1, successRate: 1 });
    expect(s.byModel["claudeAgent/claude-opus-7-1"]).toMatchObject({ success: 1, failure: 0 });
    expect(s.followedFirstRecommendation).toEqual({ followed: 1, logged: 3 });
  });

  it("filters by date", () => {
    const path = newLog();
    logDelegation(path, { taskType: "code", providerInstanceId: "a", model: "m" }, new Date("2026-01-01T00:00:00Z"));
    logDelegation(path, { taskType: "code", providerInstanceId: "a", model: "m" }, new Date("2026-06-01T00:00:00Z"));
    expect(computeStats(readLog(path), { since: new Date("2026-03-01") }).total.delegations).toBe(1);
  });
});
