import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** File names inside the data directory. */
export const DATA_FILES = {
  log: "log.jsonl",
  capabilitiesCache: "capabilities-cache.json",
  unavailable: "unavailable.json",
  subscriptions: "subscriptions.yaml",
  catalog: "catalog.yaml",
} as const;

/**
 * User data directory: $T3_AUTOPILOT_HOME or ~/.t3-autopilot. A leading `~` is
 * expanded: the `env` of an MCP server config is passed as written, with no
 * shell, and `~/x` would otherwise be a directory named `~` under whatever
 * directory the agent CLI started the server in.
 */
export function autopilotHome(): string {
  const fromEnv = process.env.T3_AUTOPILOT_HOME;
  if (!fromEnv || fromEnv.trim() === "") return join(homedir(), ".t3-autopilot");
  if (fromEnv === "~") return homedir();
  if (fromEnv.startsWith("~/") || fromEnv.startsWith("~\\")) return join(homedir(), fromEnv.slice(2));
  return fromEnv;
}

export function userPolicyPath(): string {
  return join(autopilotHome(), "policy.yaml");
}

export function logPath(): string {
  return join(autopilotHome(), DATA_FILES.log);
}

/** The default policy shipped with the package (works from src/ and dist/). */
export function defaultPolicyPath(): string {
  return fileURLToPath(new URL("../policy/default.yaml", import.meta.url));
}
