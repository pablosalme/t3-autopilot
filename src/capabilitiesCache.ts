import { z } from "zod";
import { type Capabilities, CapabilitiesSchema } from "./capabilities.js";
import { readJson, writeJsonAtomic } from "./store.js";

/** Capabilities kept between calls, in memory and in `capabilities-cache.json`. */
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

/** "45 min", "3 h 5 min": the age of an entry for a warning. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}
