import { describe, expect, test } from "vitest";
import { gateAdvisorFindings } from "../src/review/finding-gates.ts";
import type { AdvisorFinding } from "../src/review/schema.ts";

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
    expect(gateAdvisorFindings([finding()])).toEqual([finding()]);
    expect(gateAdvisorFindings([finding({ confidence: "medium" })])).toEqual([
      finding({ confidence: "medium", severity: "concern" }),
    ]);
    expect(gateAdvisorFindings([finding({ evidenceBasis: "inferred" })])).toEqual([
      finding({ evidenceBasis: "inferred", severity: "concern" }),
    ]);
  });

  test("treats missing confidence and evidence metadata conservatively", () => {
    const incomplete = finding({ confidence: undefined, evidenceBasis: undefined });
    expect(gateAdvisorFindings([incomplete])).toEqual([]);
    expect(incomplete.severity).toBe("blocker");
    expect(gateAdvisorFindings([finding({ confidence: undefined })])).toEqual([]);
    expect(gateAdvisorFindings([finding({ evidenceBasis: undefined })])).toEqual([]);
  });

  test("suppresses low-confidence or evidence-free findings", () => {
    expect(gateAdvisorFindings([finding({ confidence: "low" })])).toEqual([]);
    expect(gateAdvisorFindings([finding({ evidenceBasis: "none" })])).toEqual([]);
  });

  test("preserves accepted order without mutating downgraded findings", () => {
    const concern = finding({ fingerprint: "concern", severity: "concern", confidence: "medium" });
    const weak = finding({ fingerprint: "weak", evidenceBasis: "inferred" });
    const blocker = finding({ fingerprint: "blocker" });
    expect(gateAdvisorFindings([concern, finding({ confidence: "low" }), weak, blocker])).toEqual([
      concern,
      { ...weak, severity: "concern" },
      blocker,
    ]);
    expect(weak.severity).toBe("blocker");
    expect(gateAdvisorFindings([])).toEqual([]);
  });
});
