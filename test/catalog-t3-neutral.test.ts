import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCapabilities } from "../src/capabilities.js";
import { resolveFamilyDetail } from "../src/families.js";
import { type Recommendation, type RecommendInput, recommendModel } from "../src/recommend.js";
import { NoneUsageSource } from "../src/usage.js";
import { defaultPolicy } from "./helpers.js";

// The agent catalog adds a `policyFamily` hook to families.ts for catalog aliases (`opus`, Codex's `default`).
// T3 models never carry that field, so nothing T3 gets may change. The snapshot was taken on main before the hook
// existed (dde8c3d): for every capabilities fixture and task type, the candidates recommend_model returns and a
// hash of its whole output (reasons, skipped, warnings, setupNeeded), one line each.
// Set T3_AUTOPILOT_DUMP=<file> to write the whole outputs as JSON, to diff two versions.

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Every capabilities fixture in test/fixtures (top level and drivers/), by file name. */
function capabilityFixtures(): [string, unknown][] {
  const top = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, new URL(f, FIXTURES)] as const);
  const drivers = readdirSync(new URL("drivers/", FIXTURES))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [`drivers/${f}`, new URL(`drivers/${f}`, FIXTURES)] as const);
  return [...top, ...drivers]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, url]) => [name, JSON.parse(readFileSync(url, "utf8")) as unknown]);
}

const policy = defaultPolicy();
const taskTypes = Object.keys(policy.taskTypes).sort();

/** recommend_model's output, or its error message (a fixture where no provider can run a child task). */
async function recommend(input: RecommendInput): Promise<Recommendation | { error: string }> {
  try {
    return await recommendModel(input, policy, new NoneUsageSource());
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** `<hash of the whole output> <candidates>`, or the error. */
function line(output: Recommendation | { error: string }): string {
  const hash = createHash("sha256").update(JSON.stringify(output)).digest("hex").slice(0, 16);
  const what =
    "error" in output
      ? `error: ${output.error.split("\n")[0]}`
      : output.candidates.map((c) => `${c.providerInstanceId}/${c.model}`).join(" ");
  return `${hash} ${what}`;
}

describe("the policyFamily hook leaves T3 unchanged", () => {
  it("gives the same recommend_model output as before for every fixture and task type", async () => {
    const out: Record<string, Record<string, Recommendation | { error: string }>> = {};
    for (const [name, capabilities] of capabilityFixtures()) {
      const cases: Record<string, Recommendation | { error: string }> = {};
      for (const taskType of taskTypes) {
        cases[taskType] = await recommend({ task: "Fixture task", taskType, capabilities });
      }
      cases["code large high"] = await recommend({
        task: "Fixture task",
        taskType: "code",
        size: "large",
        criticality: "high",
        capabilities,
      });
      cases.classified = await recommend({ task: "Review the diff of the export endpoint", capabilities });
      out[name] = cases;
    }
    const dump = process.env.T3_AUTOPILOT_DUMP;
    if (dump) writeFileSync(dump, `${JSON.stringify(out, null, 1)}\n`);
    const lines = Object.entries(out).flatMap(([name, cases]) =>
      Object.entries(cases).map(([which, output]) => `${name} | ${which} | ${line(output)}`),
    );
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./snapshots/t3-recommend-outputs.txt");
  });

  it("resolves every policy family to the same model with and without the family name", () => {
    for (const [, raw] of capabilityFixtures()) {
      for (const provider of parseCapabilities(raw).providers) {
        for (const [name, family] of Object.entries(policy.families)) {
          expect(resolveFamilyDetail(family, provider, name)).toEqual(resolveFamilyDetail(family, provider));
        }
      }
    }
  });
});
