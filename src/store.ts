import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Mode of the data files (log, capabilities cache, unavailable marks,
 * subscriptions): they hold task summaries, the user's providers and their
 * plans, so only the owner reads them.
 * It applies on POSIX; Windows ignores everything but the write bit.
 */
export const PRIVATE_FILE_MODE = 0o600;

/** Pauses between the attempts of {@link renameWithRetry}: 150 ms in all. */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80];
/** What Windows answers when another process has the target open. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RenameDeps {
  rename?: (from: string, to: string) => void;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => void;
}

/**
 * Rename `from` over `to`. On Windows a rename fails with EPERM, EACCES or
 * EBUSY while another process (a second server, an antivirus scan) has the
 * target open, which lasts milliseconds: there it is tried again a few times,
 * with short pauses, before the error is thrown. Elsewhere a rename over an
 * open file works, so those errors are real and thrown at once.
 */
export function renameWithRetry(from: string, to: string, deps: RenameDeps = {}): void {
  const { rename = renameSync, platform = process.platform, sleep = sleepSync } = deps;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || delay === undefined || !code || !RENAME_RETRY_CODES.has(code)) throw e;
      sleep(delay);
    }
  }
}

/**
 * Write text atomically: to a temporary file in the same directory, then
 * renamed over the target, so a reader (another server process included)
 * never sees a half-written file. The file is readable by its owner only.
 */
export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    renameWithRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Write JSON atomically, readable by its owner only (see {@link writeTextAtomic}). */
export function writeJsonAtomic(path: string, data: unknown, indent?: number): void {
  writeTextAtomic(path, `${JSON.stringify(data, null, indent)}\n`);
}

/** Parsed JSON of a file, or undefined when it is missing, unreadable or not JSON. */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
