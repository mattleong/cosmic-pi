import { expect, it } from "@effect/vitest";
import {
  emptyAdvisorSessionMetrics,
  recordReviewDurationMetrics,
  recordUsageMetrics,
} from "../src/domain/metrics.ts";

it("aggregates only visible usage totals", () => {
  const initial = emptyAdvisorSessionMetrics();
  const first = recordUsageMetrics(initial, {
    cost: 0.125,
    totalTokens: 17,
  });
  const second = recordUsageMetrics(first, {
    cost: 0.375,
    totalTokens: 170,
  });

  expect(initial).toEqual({
    cards: 0,
    corrections: 0,
    cost: 0,
    modelResponses: 0,
    settledReviews: 0,
    totalDurationMs: 0,
    totalTokens: 0,
  });
  expect(second).toEqual({
    ...initial,
    cost: 0.5,
    modelResponses: 2,
    totalTokens: 187,
  });
});

it("records exact non-negative review durations", () => {
  const initial = emptyAdvisorSessionMetrics();
  const first = recordReviewDurationMetrics(initial, 1_000, 1_275);
  const second = recordReviewDurationMetrics(first, 2_000, 1_900);

  expect(first).toEqual({
    ...initial,
    latestDurationMs: 275,
    settledReviews: 1,
    totalDurationMs: 275,
  });
  expect(second).toEqual({
    ...initial,
    latestDurationMs: 0,
    settledReviews: 2,
    totalDurationMs: 275,
  });
});
