import { describe, expect, it } from "vitest";
import { buildOptions, clampEffort, shiftEffort } from "../src/effort.js";

const model = {
  id: "m",
  options: [
    { id: "effort", values: ["low", "medium", "high"] },
    { id: "fastMode", values: [false, true] },
    { id: "agent", values: ["build", "plan"] },
  ],
};

describe("buildOptions", () => {
  it("sets extra options only when the model declares them with that value", () => {
    const built = buildOptions(model, ["effort"], "high", { fastMode: true, agent: "review", contextWindow: "1m" });
    expect(built.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("clamps an unsupported effort and says so", () => {
    const built = buildOptions(model, ["effort"], "max", undefined);
    expect(built).toEqual({
      options: [{ id: "effort", value: "high" }],
      effort: "high",
      notes: ["effort max not supported, using high"],
    });
  });

  it("notes a model without an effort option", () => {
    expect(buildOptions({ id: "m" }, ["effort"], "high", undefined).notes).toEqual([
      "model has no effort option; using its default",
    ]);
  });
});

describe("effort scale", () => {
  it("never shifts below low, and clamps to the closest supported value", () => {
    expect(shiftEffort("low", -2)).toBe("low");
    expect(shiftEffort("high", 5)).toBe("max");
    expect(clampEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(clampEffort("minimal", ["low", "high"])).toBe("low");
    expect(clampEffort("high", ["auto", "ultrathink"])).toBeUndefined();
  });
});
