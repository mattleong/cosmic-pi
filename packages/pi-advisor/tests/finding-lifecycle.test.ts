import { describe, expect, test } from "vitest";
import {
  acknowledgeAdvisorFindings,
  advisorFindingLifecycleCounts,
  emptyAdvisorFindingLifecycle,
  MAX_FINDING_LIFECYCLE_RECORDS,
  reconcileAdvisorFindings,
  restoreAdvisorFindingLifecycle,
  supersedeAdvisorFindings,
  type AdvisorFindingLifecycleState,
  type AdvisorFindingRecord,
} from "../src/review/finding-lifecycle.ts";
import type { AdvisorFinding } from "../src/review/index.ts";

/** Drives the immutable lifecycle reducers the way application state does. */
function lifecycleDriver() {
  let state: AdvisorFindingLifecycleState = emptyAdvisorFindingLifecycle();
  return {
    reconcile(
      findings: readonly AdvisorFinding[],
      options: { scope: string; completedTurn: number; complete: boolean },
    ) {
      const result = reconcileAdvisorFindings(state, findings, options);
      state = result.state;
      return result.findings;
    },
    acknowledge(ids: readonly string[]) {
      state = acknowledgeAdvisorFindings(state, ids);
    },
    supersede(ids: readonly string[]) {
      state = supersedeAdvisorFindings(state, ids);
    },
    snapshot(): AdvisorFindingRecord[] {
      return state.records.map((record) => ({ ...record }));
    },
    restore(records: readonly AdvisorFindingRecord[] | undefined) {
      state = restoreAdvisorFindingLifecycle(records);
    },
    counts() {
      return advisorFindingLifecycleCounts(state);
    },
  };
}

const finding: AdvisorFinding = {
  fingerprint: "missing-validation",
  category: "evidence",
  severity: "concern",
  confidence: "high",
  evidenceBasis: "direct",
  issue: "Validation is missing.",
  evidence: "No test output is present.",
  recommendation: "Run the tests.",
};

describe("advisor finding lifecycle", () => {
  test("keeps stable IDs and acknowledges only after delivery", () => {
    const lifecycle = lifecycleDriver();
    const first = lifecycle.reconcile([finding], {
      scope: "session",
      completedTurn: 1,
      complete: false,
    });
    const second = lifecycle.reconcile([{ ...finding, issue: "Reworded" }], {
      scope: "session",
      completedTurn: 2,
      complete: false,
    });
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(first[0]?.status).toBe("open");
    lifecycle.acknowledge([first[0]!.id!]);
    expect(lifecycle.snapshot()[0]?.status).toBe("acknowledged");
  });

  test("reopens an acknowledged finding only when its severity escalates", () => {
    const lifecycle = lifecycleDriver();
    const first = lifecycle.reconcile([finding], {
      scope: "session",
      completedTurn: 1,
      complete: false,
    });
    lifecycle.acknowledge([first[0]!.id!]);
    expect(
      lifecycle.reconcile([finding], { scope: "session", completedTurn: 2, complete: false })[0]
        ?.status,
    ).toBe("acknowledged");
    expect(
      lifecycle.reconcile([{ ...finding, severity: "blocker" }], {
        scope: "session",
        completedTurn: 3,
        complete: false,
      })[0]?.status,
    ).toBe("open");
  });

  test("restores stable IDs and lifecycle state from bounded durable records", () => {
    const original = lifecycleDriver();
    const first = original.reconcile([finding], {
      scope: "session",
      completedTurn: 1,
      complete: false,
    });
    original.acknowledge([first[0]!.id!]);
    const restored = lifecycleDriver();
    restored.restore(original.snapshot());
    const next = restored.reconcile([finding], {
      scope: "session",
      completedTurn: 2,
      complete: false,
    });
    expect(next[0]?.id).toBe(first[0]?.id);
    expect(next[0]?.status).toBe("acknowledged");
  });

  test("supports explicit supersession without reopening terminal records", () => {
    const lifecycle = lifecycleDriver();
    const current = lifecycle.reconcile([finding], {
      scope: "session",
      completedTurn: 1,
      complete: false,
    });
    lifecycle.supersede([current[0]!.id!]);
    expect(lifecycle.snapshot()[0]?.status).toBe("superseded");
  });

  test("hard-bounds open records with oldest-first eviction", () => {
    const lifecycle = lifecycleDriver();
    for (let index = 0; index < MAX_FINDING_LIFECYCLE_RECORDS + 6; index += 1) {
      lifecycle.reconcile([{ ...finding, fingerprint: `open-${index}` }], {
        scope: "session",
        completedTurn: index + 1,
        complete: false,
      });
    }
    const records = lifecycle.snapshot();
    expect(records).toHaveLength(MAX_FINDING_LIFECYCLE_RECORDS);
    expect(Math.min(...records.map((record) => record.firstSeenTurn))).toBe(7);
    expect(lifecycle.counts()).toEqual({
      open: MAX_FINDING_LIFECYCLE_RECORDS,
      acknowledged: 0,
      resolved: 0,
      superseded: 0,
    });
  });

  test("evicts terminal records before open records at the hard bound", () => {
    const lifecycle = lifecycleDriver();
    const records = Array.from(
      { length: MAX_FINDING_LIFECYCLE_RECORDS },
      (_, index) =>
        lifecycle.reconcile([{ ...finding, fingerprint: `bounded-${index}` }], {
          scope: "session",
          completedTurn: index + 1,
          complete: false,
        })[0]!,
    );
    lifecycle.supersede([records.at(-1)!.id!]);
    lifecycle.reconcile([{ ...finding, fingerprint: "bounded-new" }], {
      scope: "session",
      completedTurn: MAX_FINDING_LIFECYCLE_RECORDS + 1,
      complete: false,
    });
    const retained = lifecycle.snapshot();
    expect(retained).toHaveLength(MAX_FINDING_LIFECYCLE_RECORDS);
    expect(retained.some((record) => record.id === records.at(-1)!.id)).toBe(false);
    expect(retained.some((record) => record.id === records[0]!.id)).toBe(true);
  });

  test("resolves omitted findings only at complete checkpoints", () => {
    const lifecycle = lifecycleDriver();
    lifecycle.reconcile([finding], { scope: "session", completedTurn: 1, complete: false });
    lifecycle.reconcile([], { scope: "session", completedTurn: 2, complete: false });
    expect(lifecycle.snapshot()[0]?.status).toBe("open");
    lifecycle.reconcile([], { scope: "session", completedTurn: 3, complete: true });
    expect(lifecycle.snapshot()[0]?.status).toBe("resolved");
  });
});
