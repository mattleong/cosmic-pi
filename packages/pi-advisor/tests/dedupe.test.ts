import { describe, expect, test } from "vitest";
import { AdvisorFindingDedupe, normalizeAdvisorFinding } from "../src/dedupe.ts";
import type { AdvisorFinding } from "../src/review.ts";

function finding(issue: string, recommendation = "Fix it."): AdvisorFinding {
  return {
    category: "correctness",
    severity: "concern",
    issue,
    evidence: "The transcript demonstrates the issue.",
    recommendation,
  };
}

describe("advisor finding dedupe", () => {
  test("normalizes case, punctuation, and whitespace", () => {
    expect(normalizeAdvisorFinding(finding(" Missing await! "))).toBe(
      "correctness missing await fix it",
    );
    expect(normalizeAdvisorFinding(finding("missing AWAIT"))).toBe(
      normalizeAdvisorFinding(finding("Missing await!")),
    );
  });

  test("suppresses repeated findings within one request scope", () => {
    const dedupe = new AdvisorFindingDedupe();
    const first = finding("Missing await!");
    const duplicate = finding(" missing AWAIT ");
    const fresh = finding("No timeout");

    expect(dedupe.filter([first], "request-1")).toEqual({ findings: [first], suppressed: 0 });
    expect(dedupe.filter([duplicate, fresh], "request-1")).toEqual({
      findings: [fresh],
      suppressed: 1,
    });
    expect(dedupe.filter([duplicate], "request-2")).toEqual({
      findings: [duplicate],
      suppressed: 0,
    });
  });

  test("evicts old findings at the bounded capacity and resets", () => {
    const dedupe = new AdvisorFindingDedupe(2);
    const first = finding("First");
    dedupe.filter([first, finding("Second"), finding("Third")]);

    expect(dedupe.filter([first])).toEqual({ findings: [first], suppressed: 0 });
    dedupe.reset();
    expect(dedupe.filter([finding("Third")]).suppressed).toBe(0);
  });
});
