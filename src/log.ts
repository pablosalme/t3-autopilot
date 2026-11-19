import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { SelectedOption } from "./capabilities.js";

export const OUTCOMES = ["success", "failure", "corrected"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Maximum length of the free-text `summary` and `note` fields. */
export const TEXT_MAX = 200;

export interface DelegationRecord {
  kind: "delegation";
  id: string;
  ts: string;
  taskType: string;
  providerInstanceId: string;
  model: string;
  options?: SelectedOption[];
  /** 1-based rank in the recommendation that was followed; null when the orchestrator chose something else. */
  recommendedRank?: number | null;
  childThreadId?: string;
  summary?: string;
}

export interface OutcomeRecord {
  kind: "outcome";
  ts: string;
  delegationId: string;
  outcome: Outcome;
  note?: string;
  /** Present when the outcome was logged without a prior log_delegation. */
  taskType?: string;
  providerInstanceId?: string;
  model?: string;
}

export type LogRecord = DelegationRecord | OutcomeRecord;

/**
 * Mode of the log: summaries and notes are the user's work, so only the owner
 * reads it (on POSIX; Windows ignores everything but the write bit). The same
 * value as PRIVATE_FILE_MODE in store.ts, repeated because this module imports
 * nothing of its own at run time: the concurrent-writers test runs it as it is.
 */
const LOG_FILE_MODE = 0o600;

/**
 * Narrow a log that was created with a wider mode (by an earlier version, or
 * by hand). Best effort: a file the user does not own stays as it is.
 */
export function makePrivate(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, LOG_FILE_MODE);
  } catch {
    // Not ours to change, or gone: the append itself reports real problems.
  }
}

function append(path: string, record: LogRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  // The mode of an append only counts when it creates the file, so an older log is narrowed afterwards.
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: LOG_FILE_MODE });
  makePrivate(path);
}

/** Cut free text to {@link TEXT_MAX} characters. */
export function truncateText<T extends string | undefined>(s: T): T {
  if (s === undefined) return s;
  return (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s) as T;
}

function newId(): string {
  return `d_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function logDelegation(
  path: string,
  entry: Omit<DelegationRecord, "kind" | "id" | "ts">,
  now: Date = new Date(),
): DelegationRecord {
  const record: DelegationRecord = {
    kind: "delegation",
    id: newId(),
    ts: now.toISOString(),
    ...entry,
    summary: truncateText(entry.summary),
  };
  if (record.summary === undefined) delete record.summary;
  append(path, record);
  return record;
}

export interface OutcomeInput {
  delegationId?: string;
  outcome: Outcome;
  note?: string;
  taskType?: string;
  providerInstanceId?: string;
  model?: string;
}

/**
 * Record the outcome of a delegation. Either `delegationId` (from
 * log_delegation) or `taskType` + `providerInstanceId` + `model` is required.
 */
export function logOutcome(path: string, input: OutcomeInput, now: Date = new Date()): OutcomeRecord {
  // Non-empty, as computeStats needs them: an outcome with an empty model would be logged and never counted.
  const standalone = Boolean(input.taskType && input.providerInstanceId && input.model);
  if (input.delegationId === undefined && !standalone) {
    throw new Error("log_outcome needs delegationId, or taskType + providerInstanceId + model");
  }
  if (input.delegationId !== undefined && !standalone) {
    const known = readLog(path).some((r) => r.kind === "delegation" && r.id === input.delegationId);
    if (!known) {
      throw new Error(
        `Unknown delegationId "${input.delegationId}". Pass taskType + providerInstanceId + model instead.`,
      );
    }
  }
  const record: OutcomeRecord = {
    kind: "outcome",
    ts: now.toISOString(),
    delegationId: input.delegationId ?? newId(),
    outcome: input.outcome,
    ...(input.note !== undefined ? { note: truncateText(input.note) } : {}),
    ...(standalone
      ? { taskType: input.taskType, providerInstanceId: input.providerInstanceId, model: input.model }
      : {}),
  };
  append(path, record);
  return record;
}

/** Read the log; malformed lines are skipped. */
export function readLog(path: string): LogRecord[] {
  if (!existsSync(path)) return [];
  const out: LogRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as LogRecord;
      if (r && (r.kind === "delegation" || r.kind === "outcome")) out.push(r);
    } catch {
      // ignore a partially written or hand-edited line
    }
  }
  return out;
}

export interface Counts {
  delegations: number;
  success: number;
  failure: number;
  corrected: number;
  pending: number;
  /** success / (success + failure + corrected); null with no outcome yet. */
  successRate: number | null;
}

export interface Stats {
  total: Counts;
  byTaskType: Record<string, Counts & { byModel: Record<string, Counts> }>;
  byModel: Record<string, Counts>;
  /** How often the first recommended candidate was used, among delegations that logged a rank. */
  followedFirstRecommendation: { followed: number; logged: number };
}

function emptyCounts(): Counts {
  return { delegations: 0, success: 0, failure: 0, corrected: 0, pending: 0, successRate: null };
}

function finish(c: Counts): void {
  const done = c.success + c.failure + c.corrected;
  c.pending = c.delegations - done;
  c.successRate = done === 0 ? null : Math.round((c.success / done) * 1000) / 1000;
}

/** Summarise the log by task type and by model. The last outcome logged for a delegation wins. */
export function computeStats(records: LogRecord[], opts: { since?: Date } = {}): Stats {
  interface Row {
    taskType: string;
    key: string;
    outcome?: Outcome;
    rank?: number | null;
  }
  const rows = new Map<string, Row>();
  const since = opts.since?.getTime();

  for (const r of records) {
    if (since !== undefined && Date.parse(r.ts) < since) continue;
    if (r.kind === "delegation") {
      rows.set(r.id, { taskType: r.taskType, key: `${r.providerInstanceId}/${r.model}`, rank: r.recommendedRank });
    } else {
      const row = rows.get(r.delegationId);
      if (row) row.outcome = r.outcome;
      else if (r.taskType && r.providerInstanceId && r.model) {
        rows.set(r.delegationId, {
          taskType: r.taskType,
          key: `${r.providerInstanceId}/${r.model}`,
          outcome: r.outcome,
        });
      }
    }
  }

  // Maps, not plain objects: task types and model keys come from the log and
  // may be any string ("constructor", "__proto__").
  const total = emptyCounts();
  const byTaskType = new Map<string, { counts: Counts; byModel: Map<string, Counts> }>();
  const byModel = new Map<string, Counts>();
  const followed = { followed: 0, logged: 0 };
  const bump = (c: Counts, o?: Outcome) => {
    c.delegations++;
    if (o) c[o]++;
  };
  const get = <T>(m: Map<string, T>, k: string, make: () => T): T => {
    let v = m.get(k);
    if (v === undefined) {
      v = make();
      m.set(k, v);
    }
    return v;
  };
  for (const row of rows.values()) {
    const t = get(byTaskType, row.taskType, () => ({ counts: emptyCounts(), byModel: new Map<string, Counts>() }));
    const tm = get(t.byModel, row.key, emptyCounts);
    const m = get(byModel, row.key, emptyCounts);
    for (const c of [total, t.counts, tm, m]) bump(c, row.outcome);
    if (row.rank !== undefined) {
      followed.logged++;
      if (row.rank === 1) followed.followed++;
    }
  }
  finish(total);
  const stats: Stats = { total, byTaskType: {}, byModel: {}, followedFirstRecommendation: followed };
  // Object.fromEntries defines own properties, so "__proto__" stays a plain key.
  stats.byTaskType = Object.fromEntries(
    [...byTaskType].map(([k, t]) => {
      finish(t.counts);
      t.byModel.forEach(finish);
      return [k, { ...t.counts, byModel: Object.fromEntries(t.byModel) }];
    }),
  );
  byModel.forEach(finish);
  stats.byModel = Object.fromEntries(byModel);
  return stats;
}
