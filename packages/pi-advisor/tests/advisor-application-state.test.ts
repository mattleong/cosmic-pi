import { describe, expect, it } from "vitest";
import {
  initialAdvisorApplicationState,
  makeAdvisorApplicationStateStore,
  recordAdvisorReceipt,
  resetAdvisorRequestDomain,
  setAdvisorSpinnerOwner,
} from "../src/advisor-application-state.ts";
import { commitAdvisorIntervention } from "../src/intervention-budget.ts";
import { normalizeAdvisorConfig } from "../src/config.ts";
import {
  emptyAdvisorToolTrajectoryDetector,
  emptyAdvisorTrajectoryDetector,
} from "../src/trajectory.ts";
import { filterAdvisorFindingsWithRollback, rollbackAdvisorFindingDedupe } from "../src/dedupe.ts";
import type { AdvisorFinding } from "../src/review.ts";

const finding: AdvisorFinding = {
  category: "correctness",
  severity: "blocker",
  issue: "A stale transition committed.",
  evidence: "epoch mismatch",
  recommendation: "Reject stale state.",
};

describe("AdvisorApplicationState reducers", () => {
  it("atomically owns epoch, cancellation, turn, and request counters", () => {
    const initial = initialAdvisorApplicationState();
    const store = makeAdvisorApplicationStateStore(initial);
    const next = store.transition((state) => ({
      ...state,
      epoch: state.epoch + 1,
      cancellationEpoch: state.cancellationEpoch + 1,
      parentTurnId: state.parentTurnId + 1,
      requestSequence: state.requestSequence + 1,
    }));
    expect(store.get()).toBe(next);
    expect(store.get()).toMatchObject({
      epoch: 1,
      cancellationEpoch: 1,
      parentTurnId: 1,
      requestSequence: 1,
    });
    expect(initial).toMatchObject({
      epoch: 0,
      cancellationEpoch: 0,
      parentTurnId: 0,
      requestSequence: 0,
    });
  });

  it("rolls dedupe admission back from immutable state", () => {
    const initial = initialAdvisorApplicationState();
    const admitted = filterAdvisorFindingsWithRollback(initial.findingDedupe, [finding], "session");
    expect(admitted.findings).toHaveLength(1);
    const rolledBack = rollbackAdvisorFindingDedupe(admitted.state, admitted.rollback);
    const retried = filterAdvisorFindingsWithRollback(rolledBack, [finding], "session");
    expect(retried.findings).toHaveLength(1);
    expect(initial.findingDedupe.order).toEqual([]);
  });

  it("resets request budgets without mutating the previous snapshot", () => {
    const initial = initialAdvisorApplicationState();
    const budgeted = {
      ...initial,
      interventionBudget: commitAdvisorIntervention(initial.interventionBudget, "blocker", true),
    };
    const reset = resetAdvisorRequestDomain(budgeted);
    expect(budgeted.interventionBudget).toMatchObject({ delivered: 1, correctionUsed: true });
    expect(reset.interventionBudget).toMatchObject({ delivered: 0, correctionUsed: false });
  });

  it("keeps prior metrics, config, recovery, and trajectory snapshots immutable", () => {
    const initial = initialAdvisorApplicationState();
    const store = makeAdvisorApplicationStateStore(initial);
    const configured = normalizeAdvisorConfig(
      { enabled: false, provider: "openai" },
      "config.json",
    );
    const trajectory = {
      abortAllowed: false,
      detector: emptyAdvisorTrajectoryDetector(),
      toolDetector: emptyAdvisorToolTrajectoryDetector(),
      generation: 1,
      id: 1,
      loopConfirmed: false,
      reviewQueued: false,
      text: "before",
      thinkingChars: 0,
      turnIndex: 1,
    };
    const recovery = {
      review: { verdict: "pass" as const, summary: "ok", suggestions: [], findings: [] },
      config: configured,
      phase: "final" as const,
      epoch: 1,
      parentTurnId: 1,
      configRevision: 1,
      cancellationEpoch: 1,
      recovering: true,
      findingIds: [],
      budgetBefore: initial.interventionBudget,
      dedupeRollback: { scope: "session", entries: [] },
      emission: {
        checkpointId: "checkpoint",
        hash: "hash",
        rollback: {
          checkpointId: "checkpoint",
          checkpointEvicted: [],
          hash: "hash",
          wasNewHash: true,
          hashEvicted: [],
        },
      },
    };
    const next = store.transition((state) => ({
      ...state,
      config: configured,
      paused: true,
      metrics: {
        ...state.metrics,
        attempted: 1,
        outcomes: { ...state.metrics.outcomes, findings: 1 },
      },
      activeTrajectory: trajectory,
      pendingPersistentRecovery: recovery,
    }));
    store.transition((state) => ({
      ...state,
      metrics: {
        ...state.metrics,
        attempted: 2,
        outcomes: { ...state.metrics.outcomes, findings: 2 },
      },
      activeTrajectory: state.activeTrajectory
        ? { ...state.activeTrajectory, text: "after" }
        : undefined,
      pendingPersistentRecovery: undefined,
    }));

    expect(initial.metrics.attempted).toBe(0);
    expect(initial.metrics.outcomes.findings).toBe(0);
    expect(initial.config.enabled).toBe(true);
    expect(initial.config.configPath).toBe("");
    expect(initial.activeTrajectory).toBeUndefined();
    expect(initial.pendingPersistentRecovery).toBeUndefined();
    expect(next.metrics).toMatchObject({ attempted: 1, outcomes: { findings: 1 } });
    expect(next.activeTrajectory?.text).toBe("before");
    expect(next.pendingPersistentRecovery).toBe(recovery);
  });

  it("coalesces receipts by request and keeps spinner ownership metadata plain", () => {
    const initial = { ...initialAdvisorApplicationState(), requestSequence: 7 };
    const first = recordAdvisorReceipt(initial, ["a"]);
    const second = recordAdvisorReceipt(first, ["a", "b"]);
    expect(second.pendingReceipt).toEqual({
      ids: ["a", "b"],
      count: 2,
      cancellationEpoch: 0,
      requestSequence: 7,
    });
    expect(setAdvisorSpinnerOwner(second, "checkpoint-1").spinner).toEqual({
      owner: "checkpoint-1",
      frame: 0,
    });
    expect(setAdvisorSpinnerOwner(second).spinner).toEqual({ frame: 0 });
  });
});
