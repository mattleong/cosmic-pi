import { describe, expect, test } from "vitest";
import {
  MAX_ADVISOR_EVIDENCE_CHARS,
  MAX_ADVISOR_FINDINGS,
  MAX_ADVISOR_FINGERPRINT_CHARS,
  MAX_ADVISOR_REVIEW_CHARS,
  MAX_ADVISOR_SUMMARY_CHARS,
  AdvisorReviewParseError,
  parseAdvisorReview,
  parseAdvisorReviewValue,
  type AdvisorReview,
} from "../src/review/index.ts";

const perspective: AdvisorReview = {
  verdict: "suggest",
  summary: "A complementary approach may simplify the work.",
  suggestions: [
    {
      fingerprint: "derive-state-from-queue",
      kind: "simplification",
      suggestion: "Consider deriving pending state from the existing queue.",
      rationale: "This may avoid synchronized mutable state.",
      relevance: "likely",
    },
  ],
  findings: [],
};

const revision: AdvisorReview = {
  verdict: "revise",
  summary: "The response misses a material requirement.",
  suggestions: [],
  findings: [
    {
      fingerprint: "unsupported-test-claim",
      category: "evidence",
      severity: "blocker",
      confidence: "high",
      evidenceBasis: "direct",
      issue: "The answer claims tests passed without evidence.",
      evidence: "No test command result appears in the transcript.",
      recommendation: "Report the actual validation result or remove the claim.",
    },
    {
      fingerprint: "missing-interface-handoff",
      category: "completeness",
      severity: "concern",
      confidence: "medium",
      evidenceBasis: "direct",
      issue: "The handoff omits the changed interface.",
      evidence: "The changed interface appears in context but not the handoff.",
      recommendation: "Name the new exported function.",
    },
  ],
};

describe("parseAdvisorReview", () => {
  test("parses a strict pass response and trims its strings", () => {
    expect(
      parseAdvisorReview(
        JSON.stringify({
          verdict: "pass",
          summary: "  The answer is sound.  ",
          suggestions: [],
          findings: [],
        }),
      ),
    ).toEqual({ verdict: "pass", summary: "The answer is sound.", suggestions: [], findings: [] });
  });

  test("rejects a review missing the required suggestions array", () => {
    expect(() =>
      parseAdvisorReview(JSON.stringify({ verdict: "pass", summary: "Fine", findings: [] })),
    ).toThrow("Advisor review must contain exactly verdict, summary, suggestions, and findings.");
  });

  test("parses a strict complementary perspective", () => {
    expect(parseAdvisorReview(JSON.stringify(perspective))).toEqual(perspective);
  });

  test("rejects mixed suggestion and correction lanes", () => {
    expect(() =>
      parseAdvisorReview(JSON.stringify({ ...revision, suggestions: perspective.suggestions })),
    ).toThrow("A revise verdict requires findings and an empty suggestions array.");
  });

  test("tolerates one JSON markdown fence", () => {
    const raw = `\n\`\`\`json\n${JSON.stringify(revision)}\n\`\`\`\n`;
    expect(parseAdvisorReview(raw)).toEqual(revision);
    expect(parseAdvisorReview(`\`\`\`\n${JSON.stringify(revision)}\n\`\`\``)).toEqual(revision);
  });

  test("rejects a pass verdict with actionable findings", () => {
    const inconsistentPass = JSON.stringify({ ...revision, verdict: "pass" });

    expect(() => parseAdvisorReview(inconsistentPass)).toThrow(
      "A pass verdict requires an empty findings array.",
    );
  });

  test("rejects low-severity findings", () => {
    const lowFinding = JSON.stringify({
      verdict: "revise",
      summary: "Minor polish only.",
      suggestions: [],
      findings: [
        {
          fingerprint: "minor-wording",
          category: "completeness",
          severity: "low",
          confidence: "low",
          evidenceBasis: "inferred",
          issue: "The wording could be tighter.",
          evidence: "One sentence is verbose.",
          recommendation: "Rewrite one sentence.",
        },
      ],
    });

    expect(() => parseAdvisorReview(lowFinding)).toThrow(
      "Advisor finding 1 has an invalid severity.",
    );
  });

  test("rejects findings beyond the supported bound before mapping them", () => {
    const findings = Array.from({ length: MAX_ADVISOR_FINDINGS + 1 }, (_, index) => ({
      fingerprint: `issue-${index + 1}`,
      category: "correctness",
      severity: index === 0 ? "blocker" : "concern",
      confidence: "high",
      evidenceBasis: "direct",
      issue: `Issue ${index + 1}`,
      evidence: `Evidence ${index + 1}`,
      recommendation: `Fix ${index + 1}`,
    }));

    expect(() =>
      parseAdvisorReview(
        JSON.stringify({
          verdict: "revise",
          summary: "Several material issues.",
          suggestions: [],
          findings,
        }),
      ),
    ).toThrow(`Advisor review must contain at most ${MAX_ADVISOR_FINDINGS} findings.`);
  });

  test("rejects duplicate canonical fingerprints", () => {
    expect(() =>
      parseAdvisorReview(
        JSON.stringify({
          ...revision,
          findings: [
            revision.findings[0],
            { ...revision.findings[1], fingerprint: " Unsupported_TEST claim " },
          ],
        }),
      ),
    ).toThrow("Advisor findings must use distinct fingerprints.");
  });

  test.each([
    ["raw review", "x".repeat(MAX_ADVISOR_REVIEW_CHARS + 1)],
    [
      "summary",
      JSON.stringify({
        verdict: "pass",
        summary: "x".repeat(MAX_ADVISOR_SUMMARY_CHARS + 1),
        suggestions: [],
        findings: [],
      }),
    ],
    [
      "fingerprint",
      JSON.stringify({
        ...revision,
        findings: [
          { ...revision.findings[0], fingerprint: "x".repeat(MAX_ADVISOR_FINGERPRINT_CHARS + 1) },
        ],
      }),
    ],
    [
      "evidence",
      JSON.stringify({
        ...revision,
        findings: [
          { ...revision.findings[0], evidence: "x".repeat(MAX_ADVISOR_EVIDENCE_CHARS + 1) },
        ],
      }),
    ],
  ])("rejects oversized %s output", (_label, raw) => {
    expect(() => parseAdvisorReview(raw)).toThrow(AdvisorReviewParseError);
  });

  test.each([
    ["empty output", ""],
    ["malformed JSON", "{"],
    ["prose around JSON", `Here is the review:\n${JSON.stringify(revision)}`],
    ["a non-JSON fence", `\`\`\`text\n${JSON.stringify(revision)}\n\`\`\``],
    [
      "a missing suggestions array",
      JSON.stringify({ verdict: "pass", summary: "Fine", findings: [] }),
    ],
    [
      "an extra root field",
      JSON.stringify({
        verdict: "pass",
        summary: "Fine",
        suggestions: [],
        findings: [],
        confidence: 1,
      }),
    ],
    [
      "an invalid verdict",
      JSON.stringify({ verdict: "maybe", summary: "Fine", suggestions: [], findings: [] }),
    ],
    [
      "an empty summary",
      JSON.stringify({ verdict: "pass", summary: " ", suggestions: [], findings: [] }),
    ],
    [
      "an invalid finding",
      JSON.stringify({
        verdict: "revise",
        summary: "Needs work",
        suggestions: [],
        findings: [{ severity: "urgent", issue: "Bad", recommendation: "Fix" }],
      }),
    ],
    [
      "an extra finding field",
      JSON.stringify({
        verdict: "revise",
        summary: "Needs work",
        suggestions: [],
        findings: [
          {
            category: "correctness",
            severity: "blocker",
            issue: "Bad",
            evidence: "Evidence",
            recommendation: "Fix",
            confidence: 1,
          },
        ],
      }),
    ],
    [
      "revise without findings",
      JSON.stringify({ verdict: "revise", summary: "Needs work", suggestions: [], findings: [] }),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseAdvisorReview(raw)).toThrow(AdvisorReviewParseError);
  });

  test.each([
    [
      "an extra root field",
      JSON.stringify({
        verdict: "pass",
        summary: "Fine",
        suggestions: [],
        findings: [],
        confidence: 1,
      }),
      "Advisor review must contain exactly verdict, summary, suggestions, and findings.",
    ],
    [
      "a missing suggestions array",
      JSON.stringify({ verdict: "pass", summary: "Fine", findings: [] }),
      "Advisor review must contain exactly verdict, summary, suggestions, and findings.",
    ],
    [
      "an invalid verdict",
      JSON.stringify({ verdict: "maybe", summary: "Fine", suggestions: [], findings: [] }),
      'Advisor verdict must be "pass", "suggest", or "revise".',
    ],
    [
      "an empty summary",
      JSON.stringify({ verdict: "pass", summary: " ", suggestions: [], findings: [] }),
      "Advisor summary must be a non-empty string.",
    ],
    ["malformed JSON", "{", "Advisor returned malformed JSON."],
    ["an empty response", "   ", "Advisor returned an empty response."],
  ])("keeps the granular diagnostic for %s", (_label, raw, message) => {
    expect(() => parseAdvisorReview(raw)).toThrow(message);
  });

  test("rejects a non-array suggestions value with the granular diagnostic", () => {
    const value = { verdict: "pass", summary: "Fine", suggestions: null, findings: [] };
    expect(() => parseAdvisorReview(JSON.stringify(value))).toThrow(
      "Advisor suggestions must be an array.",
    );
    expect(() => parseAdvisorReviewValue(value)).toThrow("Advisor suggestions must be an array.");
  });

  test("applies the same diagnostics to already-decoded review values", () => {
    expect(parseAdvisorReviewValue(JSON.parse(JSON.stringify(perspective)))).toEqual(perspective);
    expect(() =>
      parseAdvisorReviewValue({ verdict: "pass", summary: "Fine", findings: [], extra: 1 }),
    ).toThrow("Advisor review must contain exactly verdict, summary, suggestions, and findings.");
    expect(() =>
      parseAdvisorReviewValue({
        verdict: "pass",
        summary: "x".repeat(MAX_ADVISOR_REVIEW_CHARS),
        findings: [],
      }),
    ).toThrow("maximum response size");
  });
});
