import { describe, expect, it } from "vitest";
import { evaluateUsage } from "../src/usage.js";
import { defaultPolicy } from "./helpers.js";

const policy = defaultPolicy();

describe("evaluateUsage (#11)", () => {
  it("ignores windows with an unknown kind or a percentage outside 0-100", () => {
    const v = evaluateUsage(
      {
        providerInstanceId: "a",
        windows: [
          { kind: "daily", usedPercent: 99 },
          { kind: "weekly", usedPercent: 140 },
          { kind: "session", usedPercent: -3 },
          { kind: "weekly", usedPercent: Number.NaN },
        ],
      },
      "m",
      policy,
    );
    expect(v).toEqual({ tier: 0 });
  });

  it("still applies the valid windows next to invalid ones", () => {
    const v = evaluateUsage(
      { providerInstanceId: "a", windows: [{ kind: "daily", usedPercent: 99 }, { kind: "weekly", usedPercent: 100 }] },
      "m",
      policy,
    );
    expect(v.tier).toBe(2);
  });
});
