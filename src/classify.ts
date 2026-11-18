import type { Policy } from "./policy.js";

export interface Classification {
  taskType: string;
  /** Keywords that matched for the chosen type (empty when the default was used). */
  matched: string[];
  reason: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Last-resort keyword heuristic; callers should pass `taskType`. For each task
 * type, every keyword found in the task text (case-insensitive, whole words,
 * counted once) scores its number of words, so a phrase such as "review
 * comments" outweighs the single word "review". The highest score wins; ties
 * go to the type listed first in the policy. No match -> `defaultTaskType`.
 */
export function classifyTask(task: string, policy: Policy): Classification {
  const text = task.toLowerCase();
  let best: { type: string; matched: string[]; score: number } | undefined;
  for (const [type, def] of Object.entries(policy.taskTypes)) {
    const matched = def.keywords.filter((kw) => {
      const k = kw.trim().toLowerCase();
      if (!k) return false;
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(k)}($|[^\\p{L}\\p{N}_])`, "u").test(text);
    });
    const score = matched.reduce((n, kw) => n + kw.trim().split(/\s+/).length, 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { type, matched, score };
    }
  }
  if (!best) {
    return {
      taskType: policy.defaultTaskType,
      matched: [],
      reason: `no keyword matched; default type "${policy.defaultTaskType}"`,
    };
  }
  return {
    taskType: best.type,
    matched: best.matched,
    reason: `keywords matched: ${best.matched.join(", ")}`,
  };
}
