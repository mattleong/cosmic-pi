import { describe, expect, test } from "vitest";
import {
  commitAdvisorPerspective,
  emptyAdvisorPerspectiveBudget,
  MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST,
  selectAdvisorPerspective,
} from "../src/review/perspective-budget.ts";
import type { AdvisorSuggestion } from "../src/review/index.ts";

function suggestion(fingerprint: string): AdvisorSuggestion {
  return {
    fingerprint,
    kind: "alternative",
    suggestion: `Consider ${fingerprint}.`,
    rationale: "It may provide a materially different approach.",
    relevance: "likely",
  };
}

describe("advisor perspective budget", () => {
  test("selects a new semantic perspective and suppresses a normalized duplicate", () => {
    let budget = emptyAdvisorPerspectiveBudget();
    const first = suggestion("derive-state-from-queue");
    expect(selectAdvisorPerspective(budget, [first])).toBe(first);
    budget = commitAdvisorPerspective(budget, first);

    expect(
      selectAdvisorPerspective(budget, [suggestion(" Derive state FROM queue ")]),
    ).toBeUndefined();
    expect(budget.delivered).toBe(1);
  });

  test("caps optional guidance independently and resets for a genuine request", () => {
    let budget = emptyAdvisorPerspectiveBudget();
    for (let index = 0; index < MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST; index += 1) {
      budget = commitAdvisorPerspective(budget, suggestion(`angle-${index}`));
    }
    expect(selectAdvisorPerspective(budget, [suggestion("another-angle")])).toBeUndefined();

    const reset = emptyAdvisorPerspectiveBudget();
    expect(selectAdvisorPerspective(reset, [suggestion("another-angle")])).toBeDefined();
    expect(reset.delivered).toBe(0);
  });
});
