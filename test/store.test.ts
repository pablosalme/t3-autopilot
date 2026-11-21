import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logDelegation, makePrivate } from "../src/log.js";
import { PRIVATE_FILE_MODE, readJson, renameWithRetry, writeJsonAtomic } from "../src/store.js";
import { markUnavailable } from "../src/unavailable.js";
import { connectServer, fixture, tempDir } from "./helpers.js";

const posix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;

/** An error like the ones `fs.renameSync` throws. */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

/** A rename that fails with `codes` in turn, then succeeds; `calls` and `sleeps` record what happened. */
function flakyRename(codes: string[]) {
  const state = { calls: 0, sleeps: [] as number[] };
  const rename = () => {
    const code = codes[state.calls++];
    if (code) throw fsError(code);
  };
  return { state, rename, sleep: (ms: number) => void state.sleeps.push(ms) };
}

describe("renameWithRetry", () => {
  it("on Windows, tries again while another process has the target open", () => {
    const { state, rename, sleep } = flakyRename(["EPERM", "EBUSY", "EACCES"]);
    renameWithRetry("a.tmp", "a.json", { rename, sleep, platform: "win32" });
    expect(state.calls).toBe(4);
    expect(state.sleeps).toEqual([10, 20, 40]);
  });

  it("on Windows, gives up after a few attempts and throws the last error", () => {
    const { state, rename, sleep } = flakyRename(Array.from({ length: 20 }, () => "EPERM"));
    expect(() => renameWithRetry("a.tmp", "a.json", { rename, sleep, platform: "win32" })).toThrow(/EPERM/);
    expect(state.calls).toBe(5);
    expect(state.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(150);
  });

  it("on Windows, throws any other error at once", () => {
    const { state, rename, sleep } = flakyRename(["ENOENT"]);
    expect(() => renameWithRetry("a.tmp", "a.json", { rename, sleep, platform: "win32" })).toThrow(/ENOENT/);
    expect(state).toEqual({ calls: 1, sleeps: [] });
  });

  it("elsewhere, never retries: a rename over an open file works, so the error is real", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { state, rename, sleep } = flakyRename(["EPERM"]);
      expect(() => renameWithRetry("a.tmp", "a.json", { rename, sleep, platform })).toThrow(/EPERM/);
      expect(state).toEqual({ calls: 1, sleeps: [] });
    }
  });

  it("renames a real file, and waits for real between attempts", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.tmp"), "x");
    renameWithRetry(join(dir, "a.tmp"), join(dir, "a.json"));
    expect(readdirSync(dir)).toEqual(["a.json"]);

    const { state, rename } = flakyRename(["EBUSY"]);
    const started = Date.now();
    renameWithRetry("a.tmp", "a.json", { rename, platform: "win32" });
    expect(state.calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8);
  });
});

describe("data files", () => {
  it("writes JSON that reads back, and leaves no temporary file", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "data.json");
    writeJsonAtomic(path, { a: 1 }, 2);
    writeJsonAtomic(path, { a: 2 }, 2);
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 2\n}\n');
    expect(readJson(path)).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["data.json"]);
    expect(readJson(join(dir, "missing.json"))).toBeUndefined();
  });

  it.skipIf(!posix)("are readable by their owner only: the log, the capabilities caches and the marks", async () => {
    const { client, home } = await connectServer();
    await client.callTool({
      name: "recommend_model",
      arguments: { task: "x", taskType: "code", capabilities: fixture() },
    });
    await client.callTool({
      name: "log_delegation",
      arguments: { taskType: "code", providerInstanceId: "codex", model: "gpt-6.2-codex", summary: "private" },
    });
    await client.callTool({
      name: "mark_unavailable",
      arguments: { providerInstanceId: "codex", reason: "weekly limit" },
    });
    const files = readdirSync(home).sort();
    expect(files).toEqual(["capabilities-cache.json", "capabilities-cache.t3.json", "log.jsonl", "unavailable.json"]);
    for (const file of files) expect(mode(join(home, file)), file).toBe(PRIVATE_FILE_MODE);
  });

  it.skipIf(!posix)("narrow a file an earlier version left readable by others", () => {
    const dir = tempDir();
    const log = join(dir, "log.jsonl");
    const marks = join(dir, "unavailable.json");
    for (const file of [log, marks]) {
      writeFileSync(file, "");
      chmodSync(file, 0o644);
    }
    logDelegation(log, { taskType: "code", providerInstanceId: "codex", model: "gpt-6.2-codex" });
    markUnavailable(marks, { providerInstanceId: "codex", reason: "weekly limit" });
    expect(mode(log)).toBe(PRIVATE_FILE_MODE);
    expect(mode(marks)).toBe(PRIVATE_FILE_MODE);
  });

  it("makePrivate leaves Windows and missing files alone", () => {
    const dir = tempDir();
    const file = join(dir, "log.jsonl");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    makePrivate(file, "win32");
    if (posix) expect(mode(file)).toBe(0o644);
    expect(() => makePrivate(join(dir, "missing.jsonl"))).not.toThrow();
  });
});
