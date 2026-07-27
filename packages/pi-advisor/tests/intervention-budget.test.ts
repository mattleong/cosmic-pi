import { describe, expect, test } from "vitest";
import {
  canCorrectAdvisorIntervention,
  canDeliverAdvisorIntervention,
  commitAdvisorIntervention,
  emptyAdvisorInterventionBudget,
  sanitizeInterventionBudgetSnapshot,
  type AdvisorInterventionBudgetSnapshot,
} from "../src/review/intervention-budget.ts";

describe("advisor intervention budget", () => {
  test("allows only strict escalation and one correction per request", () => {
    let budget = emptyAdvisorInterventionBudget();
    expect(canDeliverAdvisorIntervention(budget, "concern")).toBe(true);
    budget = commitAdvisorIntervention(budget, "concern", true);
    expect(canCorrectAdvisorIntervention(budget)).toBe(false);
    expect(canDeliverAdvisorIntervention(budget, "concern")).toBe(false);
    expect(canDeliverAdvisorIntervention(budget, "blocker")).toBe(true);
    budget = commitAdvisorIntervention(budget, "blocker", false);
    expect(canDeliverAdvisorIntervention(budget, "blocker")).toBe(false);
  });

  test("restores a pre-reservation snapshot when delivery is cancelled", () => {
    const before: AdvisorInterventionBudgetSnapshot = emptyAdvisorInterventionBudget();
    const reserved = commitAdvisorIntervention(before, "blocker", true);
    expect(reserved).not.toEqual(before);
    const restored = sanitizeInterventionBudgetSnapshot(before);
    expect(restored).toEqual({ delivered: 0, correctionUsed: false });
    expect(canDeliverAdvisorIntervention(restored, "concern")).toBe(true);
  });

  test("resets on a genuine request boundary", () => {
    commitAdvisorIntervention(emptyAdvisorInterventionBudget(), "blocker", true);
    const reset = emptyAdvisorInterventionBudget();
    expect(canDeliverAdvisorIntervention(reset, "concern")).toBe(true);
    expect(canCorrectAdvisorIntervention(reset)).toBe(true);
  });
});
