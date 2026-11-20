import type { Policy } from "./policy.js";

/**
 * Other names an orchestrator may use for a default task type, and the type
 * each one stands for. An alias only applies when the policy has no task type
 * of that name and does have the one it points to.
 */
export const TASK_TYPE_ALIASES: Readonly<Record<string, string>> = {
  implementation: "code",
  implement: "code",
  coding: "code",
  feature: "code",
  refactor: "code",
  refactoring: "code",
  development: "code",
  programming: "code",
  tests: "code",
  testing: "code",
  bugfix: "debug",
  "bug-fix": "debug",
  fix: "debug",
  hotfix: "debug",
  bug: "debug",
  debugging: "debug",
  troubleshooting: "debug",
  docs: "writing",
  documentation: "writing",
  write: "writing",
  copywriting: "writing",
  "code-review": "review",
  "pr-review": "review",
  audit: "review",
  planning: "plan",
  architecture: "plan",
  investigation: "research",
  analysis: "research",
  trivial: "quick",
  chore: "quick",
  ui: "design",
  ux: "design",
};

export interface ResolvedTaskType {
  /** The task type of the policy. */
  taskType: string;
  /** What the caller passed, when it was not the task type's own name. */
  requested?: string;
}

/** Lower case, with spaces and underscores as hyphens: "Code Review" is "code-review". */
const normalize = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

/** Aliases whose task type the policy has, grouped by task type: "code (implementation, implement, ...)". */
function aliasList(policy: Policy): string {
  return Object.keys(policy.taskTypes)
    .map((type) => {
      const aliases = Object.entries(TASK_TYPE_ALIASES)
        .filter(([alias, target]) => target === type && !Object.hasOwn(policy.taskTypes, alias))
        .map(([alias]) => alias);
      return aliases.length ? `${type} (${aliases.join(", ")})` : type;
    })
    .join("; ");
}

/**
 * The policy's task type for a name: the name itself, the same name in another
 * case or spacing, or an alias. Throws, listing the types and their aliases,
 * when none matches.
 */
export function resolveTaskType(policy: Policy, name: string): ResolvedTaskType {
  if (Object.hasOwn(policy.taskTypes, name)) return { taskType: name };
  const norm = normalize(name);
  const target = Object.hasOwn(policy.taskTypes, norm)
    ? norm
    : Object.hasOwn(TASK_TYPE_ALIASES, norm)
      ? TASK_TYPE_ALIASES[norm]
      : undefined;
  if (target !== undefined && Object.hasOwn(policy.taskTypes, target)) return { taskType: target, requested: name };
  throw new Error(
    `Unknown taskType "${name}". Known types: ${Object.keys(policy.taskTypes).join(", ")}. ` +
      `Accepted aliases, by type: ${aliasList(policy)}.`,
  );
}
