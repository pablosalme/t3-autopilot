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
 * Keyword heuristic. For each task type, count how many of its keywords appear
 * in the task text (case-insensitive, whole words; a keyword counts once).
 * The type with the most matches wins; ties go to the type listed first in
 * the policy. No match at all -> `defaultTaskType`.
 */
export function classifyTask(task: string, policy: Policy): Classification {
  const text = task.toLowerCase();
  let best: { type: string; matched: string[] } | undefined;
  for (const [type, def] of Object.entries(policy.taskTypes)) {
    const matched = def.keywords.filter((kw) => {
      const k = kw.trim().toLowerCase();
      if (!k) return false;
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(k)}($|[^\\p{L}\\p{N}_])`, "u").test(text);
    });
    if (matched.length > 0 && (!best || matched.length > best.matched.length)) {
      best = { type, matched };
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
