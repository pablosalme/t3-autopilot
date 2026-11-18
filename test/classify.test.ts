import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/classify.js";
import { defaultPolicy } from "./helpers.js";

const policy = defaultPolicy();
const type = (task: string) => classifyTask(task, policy).taskType;

describe("classifyTask", () => {
  it.each([
    ["Review the diff of PR 42 and audit the error handling", "review"],
    ["Fix the crash when the config file is missing", "debug"],
    ["The login test is failing after the regression in auth", "debug"],
    ["Research and compare three vector databases", "research"],
    ["Write a blog post announcing the release", "writing"],
    ["Implement the export endpoint and add tests", "code"],
    ["Rename the util module and fix a typo in the header", "quick"],
    ["Plan the architecture for the sync service", "plan"],
    ["Polish the landing page layout and CSS", "design"],
    // Cases the first keyword set got wrong.
    ["Write a function that parses the header", "code"],
    ["Create the POST /users endpoint", "code"],
    ["Fix typo in README", "quick"],
    ["Implement the review comments", "code"],
    ["Revisa el PR de la exportación", "review"],
    ["Investiga y compara tres bases de datos", "research"],
    ["Fix the flaky upload test that fails on CI", "debug"],
  ])("%s -> %s", (task, expected) => {
    expect(type(task)).toBe(expected);
  });

  it("falls back to the default type with no keyword", () => {
    const c = classifyTask("Do the thing we talked about", policy);
    expect(c.taskType).toBe(policy.defaultTaskType);
    expect(c.matched).toEqual([]);
  });

  it("matches whole words only", () => {
    // "build" is a code keyword, "rebuilding" must not match it; "guide" must not match "ui".
    expect(classifyTask("rebuilding the guide", policy).matched).toEqual([]);
  });

  it("breaks ties by policy order", () => {
    // one keyword each for quick ("typo") and writing ("readme"): quick is listed first.
    expect(classifyTask("typo readme", policy).matched).toEqual(["typo"]);
  });

  it("weights phrases by their number of words", () => {
    const c = classifyTask("Implement the review comments", policy);
    expect(c.matched).toEqual(["implement", "review comments"]);
  });

  it("no longer treats generic words as signals", () => {
    for (const word of ["post", "add", "error", "fix", "plan", "verify"]) {
      expect(classifyTask(word, policy).matched).toEqual([]);
    }
  });
});
