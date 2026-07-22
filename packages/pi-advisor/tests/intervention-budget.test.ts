import { describe, expect, test } from "vitest";
import { AdvisorInterventionBudget } from "../src/review/intervention-budget.ts";

describe("advisor intervention budget", () => {
  test("allows only strict escalation and one correction per request", () => {
    const budget = new AdvisorInterventionBudget();
    expect(budget.canDeliver("concern")).toBe(true);
    budget.commit("concern", true);
    expect(budget.canCorrect()).toBe(false);
    expect(budget.canDeliver("concern")).toBe(false);
    expect(budget.canDeliver("blocker")).toBe(true);
    budget.commit("blocker", false);
    expect(budget.canDeliver("blocker")).toBe(false);
  });

  test("restores a pre-reservation snapshot when delivery is cancelled", () => {
    const budget = new AdvisorInterventionBudget();
    const before = budget.snapshot;
    budget.commit("blocker", true);
    budget.restore(before);
    expect(budget.snapshot).toEqual({ delivered: 0, correctionUsed: false });
    expect(budget.canDeliver("concern")).toBe(true);
  });

  test("resets on a genuine request boundary", () => {
    const budget = new AdvisorInterventionBudget();
    budget.commit("blocker", true);
    budget.reset();
    expect(budget.canDeliver("concern")).toBe(true);
    expect(budget.canCorrect()).toBe(true);
  });
});
