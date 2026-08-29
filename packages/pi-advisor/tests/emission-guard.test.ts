import { describe, expect, test } from "vitest";
import {
  createAdvisorEmissionGuardState,
  evaluateAdvisorEmission,
  exportAdvisorEmissionRecords,
  isContentFreeAdvisorReview,
  normalizeEmissionContent,
  rollbackAdvisorEmission,
  type AdvisorEmissionGuardState,
  type AdvisorEmissionRollback,
} from "../src/review/emission-guard.ts";
import type { AdvisorReview, AdvisorSeverity } from "../src/review/schema.ts";

/** Drives the immutable emission reducers the way application state does. */
function emissionGuard(records: readonly string[] = [], capacity?: number) {
  let state: AdvisorEmissionGuardState =
    capacity === undefined
      ? createAdvisorEmissionGuardState(records)
      : createAdvisorEmissionGuardState(records, capacity);
  return {
    evaluate(review: AdvisorReview) {
      const result = evaluateAdvisorEmission(state, review);
      state = result.state;
      return result.decision;
    },
    rollback(token: AdvisorEmissionRollback) {
      state = rollbackAdvisorEmission(state, token);
    },
    exportRecords() {
      return exportAdvisorEmissionRecords(state);
    },
  };
}

function review(severity: AdvisorSeverity, issue = "Missing timeout handling!"): AdvisorReview {
  return {
    verdict: "revise",
    summary: "A concrete issue remains.",
    suggestions: [],
    findings: [
      {
        category: "correctness",
        severity,
        issue,
        evidence: "The implementation has no bounded timeout.",
        recommendation: "Add bounded timeout handling.",
      },
    ],
  };
}

describe("advisor emission guard", () => {
  test("normalizes Unicode, case and punctuation", () => {
    expect(normalizeEmissionContent("ＭISSING—Timeout!!!")).toBe("missing timeout");
  });

  test("suppresses passes and content-free no-issue prose", () => {
    const guard = emissionGuard();
    const pass: AdvisorReview = {
      verdict: "pass",
      summary: "NO ISSUES!!!",
      suggestions: [],
      findings: [],
    };
    expect(isContentFreeAdvisorReview(pass)).toBe(true);
    expect(guard.evaluate(pass)).toEqual({ accepted: false, reason: "pass" });
  });

  test("suppresses malformed revise output whose fields only repeat no-issue/pass phrases", () => {
    const malformed: AdvisorReview = {
      verdict: "revise",
      summary: "pass",
      suggestions: [],
      findings: [
        {
          category: "correctness",
          severity: "blocker",
          issue: "NO ISSUES FOUND!!!",
          evidence: "Pass.",
          recommendation: "No changes needed",
        },
        {
          category: "evidence",
          severity: "blocker",
          issue: "No concerns detected",
          evidence: "None",
          recommendation: "Okay",
        },
      ],
    };
    expect(isContentFreeAdvisorReview(malformed)).toBe(true);
    expect(emissionGuard().evaluate(malformed)).toEqual({
      accepted: false,
      reason: "content-free",
    });
  });

  test("suppresses equal/lower normalized duplicates and accepts escalation", () => {
    const guard = emissionGuard();
    expect(guard.evaluate(review("concern")).accepted).toBe(true);
    expect(guard.evaluate(review("concern", " missing TIMEOUT handling "))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(guard.evaluate(review("blocker", "Missing timeout handling."))).toMatchObject({
      accepted: true,
      severity: "blocker",
    });
  });

  test("rolls back severity escalation without deleting the prior hash", () => {
    const guard = emissionGuard();
    expect(guard.evaluate(review("concern")).accepted).toBe(true);
    const escalation = guard.evaluate(review("blocker", "Missing timeout handling."));
    if (!escalation.accepted) throw new Error("expected escalation");
    guard.rollback(escalation.rollback);

    expect(guard.evaluate(review("concern"))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(guard.evaluate(review("blocker"))).toMatchObject({
      accepted: true,
    });
  });

  test("rolls back capacity eviction exactly", () => {
    const guard = emissionGuard([], 1);
    const first = review("concern", "First issue");
    const second = review("concern", "Second issue");
    expect(guard.evaluate(first).accepted).toBe(true);
    const accepted = guard.evaluate(second);
    if (!accepted.accepted) throw new Error("expected accepted emission");
    guard.rollback(accepted.rollback);

    expect(guard.evaluate(first)).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(guard.evaluate(second)).toMatchObject({ accepted: true });
  });

  test("rolls back an accepted recovery that never reached delivery", () => {
    const guard = emissionGuard();
    const accepted = guard.evaluate(review("blocker"));
    if (!accepted.accepted) throw new Error("expected accepted emission");
    guard.rollback(accepted.rollback);

    expect(guard.exportRecords()).toEqual([]);
    expect(guard.evaluate(review("blocker"))).toMatchObject({ accepted: true });
  });

  test("restores only bounded sanitized severity/hash records", () => {
    const first = emissionGuard();
    first.evaluate(review("concern"));
    const records = first.exportRecords();
    expect(records).toEqual([expect.stringMatching(/^concern:[a-f\d]{64}$/)]);
    const restored = emissionGuard(["garbage", ...records]);
    expect(restored.evaluate(review("concern"))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });
});
