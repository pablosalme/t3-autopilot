import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCapabilities, type Capabilities } from "../src/capabilities.js";
import { loadPolicy, mergePolicy, validatePolicy, type Policy } from "../src/policy.js";
import { parse } from "yaml";
import { defaultPolicyPath } from "../src/paths.js";

const FIXTURE = new URL("./fixtures/capabilities.json", import.meta.url);

/** A fresh, mutable copy of the fixture. */
export function fixture(): Capabilities {
  return parseCapabilities(JSON.parse(readFileSync(FIXTURE, "utf8")));
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "t3-autopilot-test-"));
}

/** The bundled default policy, ignoring any user override on this machine. */
export function defaultPolicy(): Policy {
  return loadPolicy({ userPath: join(tempDir(), "missing.yaml") }).policy;
}

/** Default policy with an override applied, as a user policy.yaml would. */
export function policyWith(override: Record<string, unknown>): Policy {
  const base = parse(readFileSync(defaultPolicyPath(), "utf8")) as Record<string, unknown>;
  return validatePolicy(mergePolicy(base, override), "test");
}
