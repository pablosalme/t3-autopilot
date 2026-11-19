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

  it("sets the effort option once when a rule also names it under options", () => {
    // `effort` wins: it is the value shifted by size and criticality and clamped to what the model supports.
    expect(buildOptions(model, ["effort"], "max", { effort: "low", fastMode: true })).toEqual({
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
      ],
      effort: "high",
      notes: ["effort max not supported, using high"],
    });
    // With no `effort`, the entry under `options` is an ordinary option.
    expect(buildOptions(model, ["effort"], undefined, { effort: "low" }).options).toEqual([
      { id: "effort", value: "low" },
    ]);
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
