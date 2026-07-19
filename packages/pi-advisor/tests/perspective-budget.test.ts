import { describe, expect, test } from "vitest";
import {
  AdvisorPerspectiveBudget,
  MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST,
} from "../src/perspective-budget.ts";
import type { AdvisorSuggestion } from "../src/review.ts";

function suggestion(fingerprint: string): AdvisorSuggestion {
  return {
    fingerprint,
    kind: "alternative",
    suggestion: `Consider ${fingerprint}.`,
    rationale: "It may provide a materially different approach.",
    relevance: "likely",
  };
}

describe("AdvisorPerspectiveBudget", () => {
  test("selects a new semantic perspective and suppresses a normalized duplicate", () => {
    const budget = new AdvisorPerspectiveBudget();
    const first = suggestion("derive-state-from-queue");
    expect(budget.select([first])).toBe(first);
    budget.commit(first);

    expect(budget.select([suggestion(" Derive state FROM queue ")])).toBeUndefined();
    expect(budget.count).toBe(1);
  });

  test("caps optional guidance independently and resets for a genuine request", () => {
    const budget = new AdvisorPerspectiveBudget();
    for (let index = 0; index < MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST; index += 1) {
      const next = suggestion(`angle-${index}`);
      budget.commit(next);
    }
    expect(budget.select([suggestion("another-angle")])).toBeUndefined();

    budget.reset();
    expect(budget.select([suggestion("another-angle")])).toBeDefined();
    expect(budget.count).toBe(0);
  });
});
