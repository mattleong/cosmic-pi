import { describe, expect, test } from "vitest";
import {
  acknowledgeAdvisorFindings,
  emptyAdvisorFindingLifecycle,
  MAX_FINDING_LIFECYCLE_RECORDS,
  reconcileAdvisorFindings,
  restoreAdvisorFindingLifecycle,
  type AdvisorFindingLifecycleState,
  type AdvisorFindingRecord,
} from "../src/review/finding-lifecycle.ts";
import type { AdvisorFinding } from "../src/review/schema.ts";

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
    snapshot(): AdvisorFindingRecord[] {
      return state.records.map((record) => ({ ...record }));
    },
    restore(records: readonly AdvisorFindingRecord[] | undefined) {
      state = restoreAdvisorFindingLifecycle(records);
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

  test("restores legacy superseded records and opens a new generation", () => {
    const lifecycle = lifecycleDriver();
    const current = lifecycle.reconcile([finding], {
      scope: "session",
      completedTurn: 1,
      complete: false,
    });
    lifecycle.restore(
      lifecycle.snapshot().map((record) => ({ ...record, status: "superseded" as const })),
    );

    const next = lifecycle.reconcile([finding], {
      scope: "session",
      completedTurn: 2,
      complete: false,
    });
    const snapshot = lifecycle.snapshot();
    expect(next[0]?.id).not.toBe(current[0]?.id);
    expect(next[0]?.status).toBe("open");
    expect(snapshot.find((record) => record.id === current[0]?.id)?.status).toBe("superseded");
    expect(snapshot.find((record) => record.id === next[0]?.id)?.generation).toBe(1);
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
    expect(records.every((record) => record.status === "open")).toBe(true);
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
    const supersededId = records.at(-1)!.id!;
    lifecycle.restore(
      lifecycle
        .snapshot()
        .map((record) =>
          record.id === supersededId ? { ...record, status: "superseded" as const } : record,
        ),
    );
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
