import { describe, expect, it } from "vitest";
import type { Recommendation } from "../src/recommend.js";
import { connectServer, driverFixtureRaw, resultText, tempDir } from "./helpers.js";

type Result = Recommendation & { capabilitiesFrom: string };

const T0 = new Date("2026-11-19T08:00:00Z");
const ids = (r: Result) => r.candidates.map((c) => `${c.providerInstanceId}/${c.model}`);
const okData = (res: object) => {
  expect((res as { isError?: boolean }).isError, resultText(res)).toBeFalsy();
  return (res as { structuredContent: Result }).structuredContent;
};

/** A server on `home`; `call` sends recommend_model without waiting for earlier calls. */
async function serverOn(home: string) {
  const { client } = await connectServer(home, { now: () => T0 });
  return (args: Record<string, unknown> = {}) =>
    client.callTool({ name: "recommend_model", arguments: { task: "x", taskType: "code", ...args } });
}

// An orchestrator that delegates several children at once sends its recommend_model calls together: the
// first carries the capabilities, the others omit them.
describe("recommend_model calls sent at once", () => {
  it("the calls that omit capabilities use the ones the first call carries", async () => {
    const call = await serverOn(tempDir());
    const [first, second, third] = await Promise.all([
      call({ capabilities: driverFixtureRaw("mixed") }),
      call(),
      call(),
    ]);
    expect(okData(first).capabilitiesFrom).toBe("call");
    expect(okData(second).capabilitiesFrom).toBe("cache");
    expect(okData(third).capabilitiesFrom).toBe("cache");
    expect(ids(okData(third))).toEqual(ids(okData(first)));
  });

  it("after a restart, a merged search is seen by the calls sent with it and is not lost afterwards", async () => {
    const home = tempDir();
    okData(await (await serverOn(home))({ capabilities: driverFixtureRaw("mixed") }));

    const call = await serverOn(home);
    const search = { capabilities: driverFixtureRaw("search-mixed-cursor-opus"), mergeCapabilities: true };
    const [merged, second, third] = await Promise.all([call(search), call(), call()]);
    expect(okData(merged).capabilitiesFrom).toBe("merged");
    for (const res of [merged, second, third, await call()]) {
      expect(ids(okData(res))).toContain("cursor/claude-opus-9-2");
    }
  });

  it("a failed call does not hold back the ones behind it", async () => {
    const call = await serverOn(tempDir());
    const [bad, good, cached] = await Promise.all([
      call({ capabilities: "{not json" }),
      call({ capabilities: driverFixtureRaw("mixed") }),
      call(),
    ]);
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(okData(good).capabilitiesFrom).toBe("call");
    expect(okData(cached).capabilitiesFrom).toBe("cache");
  });
});
