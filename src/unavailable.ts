import { z } from "zod";
import { truncateText } from "./log.js";
import { readJson, writeJsonAtomic } from "./store.js";

/** How long a mark lasts when the caller does not say when the limit resets. */
export const UNAVAILABLE_DEFAULT_HOURS = 24;

/**
 * A provider instance, or one of its models, that cannot run children for a
 * while (a usage limit, a plan that does not include the model). Unlike a
 * `failure` outcome, it says nothing about the quality of the model.
 */
export const UnavailableMarkSchema = z.object({
  providerInstanceId: z.string(),
  /** Absent: every model of the provider instance. */
  model: z.string().optional(),
  reason: z.string(),
  markedAt: z.string(),
  until: z.string(),
});
export type UnavailableMark = z.infer<typeof UnavailableMarkSchema>;

const MarksFileSchema = z.object({ version: z.literal(1), marks: z.array(UnavailableMarkSchema) });

export interface MarkInput {
  providerInstanceId: string;
  model?: string;
  reason: string;
  /** ISO date when it should be available again; {@link UNAVAILABLE_DEFAULT_HOURS} from now by default. */
  until?: string;
}

/** Marks in the file; a missing or malformed file has none. */
export function readMarks(path: string): UnavailableMark[] {
  const parsed = MarksFileSchema.safeParse(readJson(path));
  return parsed.success ? parsed.data.marks : [];
}

/** Marks still in force at `now`. */
export function activeMarks(path: string, now: Date): UnavailableMark[] {
  return readMarks(path).filter((m) => Date.parse(m.until) > now.getTime());
}

function write(path: string, marks: UnavailableMark[]): void {
  writeJsonAtomic(path, { version: 1, marks }, 2);
}

const sameTarget = (a: { providerInstanceId: string; model?: string }, b: typeof a) =>
  a.providerInstanceId === b.providerInstanceId && a.model === b.model;

/** Add a mark (replacing one for the same provider instance and model) and drop expired ones. */
export function markUnavailable(path: string, input: MarkInput, now: Date = new Date()): UnavailableMark {
  let until = new Date(now.getTime() + UNAVAILABLE_DEFAULT_HOURS * 3_600_000);
  if (input.until !== undefined) {
    until = new Date(input.until);
    if (Number.isNaN(until.getTime())) throw new Error(`Invalid date in until: "${input.until}"`);
    if (until.getTime() <= now.getTime()) {
      throw new Error(`until (${input.until}) is not in the future. To remove a mark, pass clear: true.`);
    }
  }
  const mark: UnavailableMark = {
    providerInstanceId: input.providerInstanceId,
    ...(input.model === undefined ? {} : { model: input.model }),
    reason: truncateText(input.reason),
    markedAt: now.toISOString(),
    until: until.toISOString(),
  };
  write(path, [...activeMarks(path, now).filter((m) => !sameTarget(m, mark)), mark]);
  return mark;
}

/**
 * Remove the marks of a provider instance: all of them, or with `model` only
 * that model's. Returns the marks removed.
 */
export function clearUnavailable(
  path: string,
  target: { providerInstanceId: string; model?: string },
  now: Date = new Date(),
): UnavailableMark[] {
  const marks = activeMarks(path, now);
  const hit = (m: UnavailableMark) =>
    m.providerInstanceId === target.providerInstanceId && (target.model === undefined || m.model === target.model);
  write(
    path,
    marks.filter((m) => !hit(m)),
  );
  return marks.filter(hit);
}

/** The mark that applies to a model of a provider instance: one for that model, else one for the whole instance. */
export function findMark(
  marks: readonly UnavailableMark[],
  providerInstanceId: string,
  model: string,
): UnavailableMark | undefined {
  return (
    marks.find((m) => m.providerInstanceId === providerInstanceId && m.model === model) ??
    marks.find((m) => m.providerInstanceId === providerInstanceId && m.model === undefined)
  );
}

/** "cursor/gemini-4-neon" or "cursor (every model)". */
export function markTarget(mark: UnavailableMark): string {
  return mark.model === undefined
    ? `${mark.providerInstanceId} (every model)`
    : `${mark.providerInstanceId}/${mark.model}`;
}
