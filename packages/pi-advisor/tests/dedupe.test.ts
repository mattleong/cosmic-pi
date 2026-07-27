import { describe, expect, test } from "vitest";
import {
  emptyAdvisorFindingDedupe,
  filterAdvisorFindingsWithRollback,
  normalizeAdvisorFinding,
  rollbackAdvisorFindingDedupe,
  type AdvisorFindingDedupeRollback,
  type AdvisorFindingDedupeState,
} from "../src/review/dedupe.ts";
import type { AdvisorFinding } from "../src/review/index.ts";

/** Drives the immutable reducers the way application state does. */
function dedupeDriver(capacity?: number) {
  let state: AdvisorFindingDedupeState =
    capacity === undefined ? emptyAdvisorFindingDedupe() : emptyAdvisorFindingDedupe(capacity);
  return {
    filter(findings: readonly AdvisorFinding[], scope = "default") {
      const {
        rollback: _rollback,
        state: next,
        ...result
      } = filterAdvisorFindingsWithRollback(state, findings, scope);
      state = next;
      return result;
    },
    filterWithRollback(findings: readonly AdvisorFinding[], scope = "default") {
      const result = filterAdvisorFindingsWithRollback(state, findings, scope);
      state = result.state;
      const { state: _state, ...publicResult } = result;
      return publicResult;
    },
    rollback(token: AdvisorFindingDedupeRollback) {
      state = rollbackAdvisorFindingDedupe(state, token);
    },
    reset() {
      state = emptyAdvisorFindingDedupe(state.capacity);
    },
  };
}

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
    const dedupe = dedupeDriver();
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

  test("rolls back severity escalation without losing the prior severity", () => {
    const dedupe = dedupeDriver();
    const concern = finding("Escalating issue");
    const blocker = { ...concern, severity: "blocker" as const };
    dedupe.filter([concern]);
    const filtered = dedupe.filterWithRollback([blocker]);
    expect(filtered.findings).toEqual([blocker]);
    dedupe.rollback(filtered.rollback);

    expect(dedupe.filter([concern])).toEqual({ findings: [], suppressed: 1 });
    expect(dedupe.filter([blocker])).toEqual({ findings: [blocker], suppressed: 0 });
  });

  test("rolls back capacity eviction exactly", () => {
    const dedupe = dedupeDriver(1);
    const first = finding("First");
    const second = finding("Second");
    dedupe.filter([first]);
    const filtered = dedupe.filterWithRollback([second]);
    expect(filtered.findings).toEqual([second]);
    dedupe.rollback(filtered.rollback);

    expect(dedupe.filter([first])).toEqual({ findings: [], suppressed: 1 });
    expect(dedupe.filter([second])).toEqual({ findings: [second], suppressed: 0 });
  });

  test("evicts old findings at the bounded capacity and resets", () => {
    const dedupe = dedupeDriver(2);
    const first = finding("First");
    dedupe.filter([first, finding("Second"), finding("Third")]);

    expect(dedupe.filter([first])).toEqual({ findings: [first], suppressed: 0 });
    dedupe.reset();
    expect(dedupe.filter([finding("Third")]).suppressed).toBe(0);
  });
});
