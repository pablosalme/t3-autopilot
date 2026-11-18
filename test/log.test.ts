import { appendFileSync, readFileSync } from "node:fs";
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

describe("review regressions", () => {
  it("handles task types that are Object.prototype keys (#6)", () => {
    const path = newLog();
    for (const t of ["constructor", "__proto__", "toString"]) {
      logOutcome(path, { taskType: t, providerInstanceId: "a", model: "m", outcome: "success" });
    }
    const s = computeStats(readLog(path));
    expect(Object.keys(s.byTaskType).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(s.byTaskType, "__proto__")).toBe(true);
    expect(s.byTaskType.constructor).toMatchObject({ success: 1, delegations: 1 });
    expect(JSON.parse(JSON.stringify(s)).byTaskType.__proto__.success).toBe(1);
  });

  it("truncates notes like summaries (#12)", () => {
    const r = logOutcome(newLog(), { taskType: "code", providerInstanceId: "a", model: "m", outcome: "failure", note: "y".repeat(1000) });
    expect(r.note!.length).toBe(200);
  });
});

describe("concurrent writers", () => {
  // Node runs src/log.ts directly only with type stripping (22.18+); vitest itself needs 22.12+.
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const canStripTypes = major > 22 || (major === 22 && minor >= 18);

  it.runIf(canStripTypes)("keeps every line intact when several processes append at once", async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const writer = fileURLToPath(new URL("./fixtures/log-writer.mjs", import.meta.url));
    const path = newLog();
    const workers = 4;
    const perWorker = 50;
    await Promise.all(
      Array.from({ length: workers }, (_, w) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [writer, path, String(w), String(perWorker)], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}: ${stderr}`))));
        }),
      ),
    );
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(workers * perWorker * 2);
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
    const s = computeStats(readLog(path));
    expect(s.total).toMatchObject({ delegations: workers * perWorker, success: workers * perWorker / 2, corrected: workers * perWorker / 2, pending: 0 });
    expect(s.followedFirstRecommendation).toEqual({ followed: workers * perWorker, logged: workers * perWorker });
  }, 30_000);
});
