import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse } from "yaml";
import { parseCapabilities, type Capabilities } from "../src/capabilities.js";
import { defaultPolicyPath } from "../src/paths.js";
import { loadPolicy, mergePolicy, validatePolicy, type Policy } from "../src/policy.js";
import { createServer } from "../src/server.js";

const FIXTURE = new URL("./fixtures/capabilities.json", import.meta.url);

/** A fresh, mutable copy of the fixture. */
export function fixture(): Capabilities {
  return parseCapabilities(JSON.parse(readFileSync(FIXTURE, "utf8")));
}

/** Raw JSON of an invented per-driver fixture in test/fixtures/drivers/<name>.json. */
export function driverFixtureRaw(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/drivers/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
}

/** Parsed per-driver fixture. */
export function driverFixture(name: string): Capabilities {
  return parseCapabilities(driverFixtureRaw(name));
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

/**
 * An MCP client connected in memory to a fresh server whose data directory
 * (policy.yaml, log.jsonl) is `home`, a new temporary directory by default.
 */
export async function connectServer(home = tempDir()): Promise<{ client: Client; home: string }> {
  const server = createServer({
    loadPolicy: () => loadPolicy({ userPath: join(home, "policy.yaml") }),
    logPath: () => join(home, "log.jsonl"),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, home };
}
