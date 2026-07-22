import { describe, expect, test } from "vitest";
import {
  AdvisorEmissionGuard,
  isContentFreeAdvisorReview,
  normalizeEmissionContent,
} from "../src/review/emission-guard.ts";
import type { AdvisorReview, AdvisorSeverity } from "../src/review/index.ts";

function review(severity: AdvisorSeverity, issue = "Missing timeout handling!"): AdvisorReview {
  return {
    verdict: "revise",
    summary: "A concrete issue remains.",
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

describe("AdvisorEmissionGuard", () => {
  test("normalizes Unicode, case and punctuation", () => {
    expect(normalizeEmissionContent("ＭISSING—Timeout!!!")).toBe("missing timeout");
  });

  test("suppresses passes and content-free no-issue prose", () => {
    const guard = new AdvisorEmissionGuard();
    const pass: AdvisorReview = { verdict: "pass", summary: "NO ISSUES!!!", findings: [] };
    expect(isContentFreeAdvisorReview(pass)).toBe(true);
    expect(guard.evaluate("one", pass)).toEqual({ accepted: false, reason: "pass" });
  });

  test("suppresses malformed revise output whose fields only repeat no-issue/pass phrases", () => {
    const malformed: AdvisorReview = {
      verdict: "revise",
      summary: "pass",
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
    expect(new AdvisorEmissionGuard().evaluate("malformed", malformed)).toEqual({
      accepted: false,
      reason: "content-free",
    });
  });

  test("accepts at most one delivery per checkpoint without consuming a later slot", () => {
    const guard = new AdvisorEmissionGuard();
    expect(guard.evaluate("one", review("concern")).accepted).toBe(true);
    expect(guard.evaluate("one", review("blocker"))).toEqual({
      accepted: false,
      reason: "checkpoint-budget",
    });
    expect(guard.evaluate("two", review("blocker")).accepted).toBe(true);
    expect(guard.evaluate("one", review("blocker", "A different issue"))).toEqual({
      accepted: false,
      reason: "checkpoint-budget",
    });
  });

  test("suppresses equal/lower normalized duplicates and accepts escalation", () => {
    const guard = new AdvisorEmissionGuard();
    expect(guard.evaluate("one", review("concern")).accepted).toBe(true);
    expect(guard.evaluate("two", review("nit", " missing TIMEOUT handling "))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(guard.evaluate("three", review("blocker", "Missing timeout handling."))).toMatchObject({
      accepted: true,
      severity: "blocker",
    });
  });

  test("rolls back severity escalation without deleting the prior hash", () => {
    const guard = new AdvisorEmissionGuard();
    expect(guard.evaluate("one", review("concern")).accepted).toBe(true);
    const escalation = guard.evaluate("two", review("blocker", "Missing timeout handling."));
    if (!escalation.accepted) throw new Error("expected escalation");
    guard.rollback(escalation.rollback);

    expect(guard.evaluate("retry-concern", review("concern"))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(guard.evaluate("retry-blocker", review("blocker"))).toMatchObject({
      accepted: true,
    });
  });

  test("rolls back capacity eviction exactly", () => {
    const guard = new AdvisorEmissionGuard([], 1);
    const first = review("concern", "First issue");
    const second = review("concern", "Second issue");
    expect(guard.evaluate("one", first).accepted).toBe(true);
    const accepted = guard.evaluate("two", second);
    if (!accepted.accepted) throw new Error("expected accepted emission");
    guard.rollback(accepted.rollback);

    expect(guard.evaluate("first-retry", first)).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(guard.evaluate("second-retry", second)).toMatchObject({ accepted: true });
  });

  test("rolls back an accepted recovery that never reached delivery", () => {
    const guard = new AdvisorEmissionGuard();
    const accepted = guard.evaluate("aborted", review("blocker"));
    if (!accepted.accepted) throw new Error("expected accepted emission");
    guard.rollback(accepted.rollback);

    expect(guard.exportRecords()).toEqual([]);
    expect(guard.evaluate("retry", review("blocker"))).toMatchObject({ accepted: true });
  });

  test("restores only bounded sanitized severity/hash records", () => {
    const first = new AdvisorEmissionGuard();
    first.evaluate("one", review("concern"));
    const records = first.exportRecords();
    expect(records).toEqual([expect.stringMatching(/^concern:[a-f\d]{64}$/)]);
    const restored = new AdvisorEmissionGuard(["garbage", ...records]);
    expect(restored.evaluate("two", review("concern"))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });
});
