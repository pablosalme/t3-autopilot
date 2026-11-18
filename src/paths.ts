import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** User data directory: $T3_AUTOPILOT_HOME or ~/.t3-autopilot. */
export function autopilotHome(): string {
  const fromEnv = process.env.T3_AUTOPILOT_HOME;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : join(homedir(), ".t3-autopilot");
}

export function userPolicyPath(): string {
  return join(autopilotHome(), "policy.yaml");
}

export function logPath(): string {
  return join(autopilotHome(), "log.jsonl");
}

/** The default policy shipped with the package (works from src/ and dist/). */
export function defaultPolicyPath(): string {
  return fileURLToPath(new URL("../policy/default.yaml", import.meta.url));
}
