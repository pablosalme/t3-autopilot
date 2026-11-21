import { z } from "zod";
import { type Capabilities, CapabilitiesSchema } from "./capabilities.js";
import { readJson, writeJsonAtomic } from "./store.js";

/**
 * Capabilities kept between calls: in memory, in the host's cache file
 * (`capabilities-cache.<host>.json`, one entry per session) and, for T3 Code,
 * in `capabilities-cache.json`, the single entry 0.1 reads and writes.
 */
export interface CapabilitiesEntry {
  capabilities: Capabilities;
  /**
   * When the full orchestrator_capabilities output this entry is built on was
   * received. Merging a `search` output keeps it, so merges never make an old
   * catalog look fresh.
   */
  receivedAt: string;
  /** Whether `search` outputs were merged into it. */
  merged: boolean;
}

const CacheFileSchema = z.object({
  version: z.literal(1),
  receivedAt: z.string(),
  merged: z.boolean(),
  capabilities: CapabilitiesSchema,
});

export function saveCapabilitiesCache(path: string, entry: CapabilitiesEntry): void {
  writeJsonAtomic(path, { version: 1, ...entry });
}

/**
 * The saved entry if it exists, is valid and is younger than `ttlHours`;
 * undefined otherwise (also when `ttlHours` is 0, which turns the disk cache off).
 */
export function loadCapabilitiesCache(path: string, ttlHours: number, now: Date): CapabilitiesEntry | undefined {
  if (ttlHours <= 0) return undefined;
  const parsed = CacheFileSchema.safeParse(readJson(path));
  if (!parsed.success) return undefined;
  const received = Date.parse(parsed.data.receivedAt);
  if (Number.isNaN(received) || now.getTime() - received > ttlHours * 3_600_000) return undefined;
  const { capabilities, receivedAt, merged } = parsed.data;
  return { capabilities, receivedAt, merged };
}

/** How many sessions a host's cache file keeps: the most recently saved ones. */
export const SESSION_ENTRIES_MAX = 32;

const SessionEntrySchema = z.object({
  receivedAt: z.string(),
  /** When this entry was last saved: the most recent one stands in for a call that names no session. */
  savedAt: z.string(),
  merged: z.boolean(),
  capabilities: CapabilitiesSchema,
});
type SessionEntry = z.infer<typeof SessionEntrySchema>;

const isFresh = (receivedAt: string, ttlHours: number, now: Date) => {
  const received = Date.parse(receivedAt);
  return !Number.isNaN(received) && now.getTime() - received <= ttlHours * 3_600_000;
};

/** Most recently saved first; the sort is stable, so a tie keeps the order given (the file's, newest first). */
const bySavedAt = (a: SessionEntry, b: SessionEntry) => (Date.parse(b.savedAt) || 0) - (Date.parse(a.savedAt) || 0);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The valid entries of a host's cache file (`{ version: 1, entries: { <session>: entry } }`), by session; none
 * when it is missing or not one. Each entry is checked on its own, so a bad one does not lose the others, and
 * the keys are read as JSON gives them, so a session named "__proto__" stays one.
 */
function readSessions(path: string): Map<string, SessionEntry> {
  const out = new Map<string, SessionEntry>();
  const file = readJson(path);
  if (!isObject(file) || file.version !== 1 || !isObject(file.entries)) return out;
  for (const [session, raw] of Object.entries(file.entries)) {
    const entry = SessionEntrySchema.safeParse(raw);
    if (entry.success) out.set(session, entry.data);
  }
  return out;
}

const toEntry = ({ capabilities, receivedAt, merged }: SessionEntry): CapabilitiesEntry => ({
  capabilities,
  receivedAt,
  merged,
});

/**
 * The entry a host's cache file keeps for a session, if it is valid and
 * younger than `ttlHours`.
 */
export function loadSessionEntry(
  path: string,
  session: string,
  ttlHours: number,
  now: Date,
): CapabilitiesEntry | undefined {
  if (ttlHours <= 0) return undefined;
  const entry = readSessions(path).get(session);
  return entry && isFresh(entry.receivedAt, ttlHours, now) ? toEntry(entry) : undefined;
}

/** The entry of a host's cache file saved last, of any session, if it is younger than `ttlHours`. */
export function loadLatestEntry(path: string, ttlHours: number, now: Date): CapabilitiesEntry | undefined {
  if (ttlHours <= 0) return undefined;
  const fresh = [...readSessions(path).values()].filter((e) => isFresh(e.receivedAt, ttlHours, now));
  const latest = fresh.sort(bySavedAt)[0];
  return latest && toEntry(latest);
}

/**
 * Save a session's entry in a host's cache file, atomically. Entries older
 * than `ttlHours` are dropped, and only the {@link SESSION_ENTRIES_MAX} saved
 * last are kept. The session "" holds a call that named none.
 */
export function saveSessionEntry(
  path: string,
  session: string,
  entry: CapabilitiesEntry,
  now: Date,
  ttlHours: number,
): void {
  const others = [...readSessions(path)].filter(([name]) => name !== session);
  // The new entry first: it wins a tie with an entry saved at the same instant.
  const kept = [[session, { ...entry, savedAt: now.toISOString() }] as const, ...others]
    .filter(([, e]) => isFresh(e.receivedAt, ttlHours, now))
    .sort(([, a], [, b]) => bySavedAt(a, b))
    .slice(0, SESSION_ENTRIES_MAX);
  // Object.fromEntries defines own properties, so a session named "__proto__" stays a plain key.
  writeJsonAtomic(path, { version: 1, entries: Object.fromEntries(kept) });
}

/** "45 min", "3 h 5 min": the age of an entry for a warning. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}
