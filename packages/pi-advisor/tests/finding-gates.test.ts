import { describe, expect, test } from "vitest";
import { gateAdvisorFinding } from "../src/finding-gates.ts";
import type { AdvisorFinding } from "../src/review.ts";

function finding(overrides: Partial<AdvisorFinding> = {}): AdvisorFinding {
  return {
    fingerprint: "issue",
    category: "correctness",
    severity: "blocker",
    confidence: "high",
    evidenceBasis: "direct",
    issue: "Wrong result",
    evidence: "The result contradicts the tool output.",
    recommendation: "Correct the result.",
    ...overrides,
  };
}

describe("advisor finding gates", () => {
  test("requires high confidence and direct evidence for blockers", () => {
    expect(gateAdvisorFinding(finding()).effectiveSeverity).toBe("blocker");
    expect(gateAdvisorFinding(finding({ confidence: "medium" })).effectiveSeverity).toBe("concern");
    expect(gateAdvisorFinding(finding({ evidenceBasis: "inferred" })).effectiveSeverity).toBe(
      "concern",
    );
  });

  test("treats missing confidence and evidence metadata conservatively", () => {
    const legacy = finding({ confidence: undefined, evidenceBasis: undefined });
    expect(gateAdvisorFinding(legacy)).toMatchObject({
      actionable: false,
      effectiveSeverity: "nit",
      reason: "low-confidence",
    });
  });

  test("suppresses low-confidence or evidence-free findings", () => {
    expect(gateAdvisorFinding(finding({ confidence: "low" })).actionable).toBe(false);
    expect(gateAdvisorFinding(finding({ evidenceBasis: "none" })).actionable).toBe(false);
  });
});
