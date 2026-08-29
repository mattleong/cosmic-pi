import { expect, test } from "@effect/vitest";
import {
  beginAdvisorUserRequest,
  cancelAdvisorRequest,
  commitAdvisorConfig,
  initializeAdvisorSession,
  initialAdvisorApplicationState,
  resetAdvisorRequestDomain,
  settleAdvisorPendingRecovery,
  type AdvisorApplicationState,
} from "../src/application/state.ts";
import {
  emptyAdvisorTrajectoryDetector,
  emptyAdvisorToolTrajectoryDetector,
} from "../src/review/trajectory.ts";
import { resolvedAdvisorConfig } from "./support/config.ts";

const pendingRecovery = (): AdvisorApplicationState["pendingPersistentRecovery"] => ({
  review: { verdict: "pass", summary: "review", suggestions: [], findings: [] },
  epoch: 7,
  parentTurnId: 11,
  turnIndex: 2,
  trajectoryId: 3,
  cancellationEpoch: 13,
  findingIds: ["finding-id"],
  budgetBefore: { delivered: 1, highestSeverity: "concern", correctionUsed: false },
  dedupeRollback: {
    scope: "scope",
    entries: [{ key: "finding", wasNew: true, evicted: [] }],
  },
  emissionRollback: {
    hash: "hash",
    wasNewHash: true,
    hashEvicted: [],
  },
});

const advancedState = (): AdvisorApplicationState => ({
  ...initialAdvisorApplicationState(resolvedAdvisorConfig()),
  activeTrajectory: {
    abortAllowed: true,
    detector: emptyAdvisorTrajectoryDetector(),
    toolDetector: emptyAdvisorToolTrajectoryDetector(),
    generation: 11,
    id: 3,
    loopConfirmed: true,
    reviewQueued: true,
    text: "trajectory",
    thinkingChars: 10,
    turnIndex: 2,
  },
  pendingPersistentRecovery: pendingRecovery(),
  epoch: 7,
  cancellationEpoch: 13,
  parentTurnId: 11,
  requestSequence: 17,
  findingDedupe: {
    capacity: 8,
    scope: "scope",
    seen: { finding: "concern" },
    order: ["finding"],
  },
  findingLifecycle: {
    records: [
      {
        id: "finding-id",
        key: "finding-key",
        generation: 0,
        category: "correctness",
        severity: "concern",
        status: "open",
        firstSeenTurn: 1,
        lastSeenTurn: 1,
      },
    ],
  },
  interventionBudget: { delivered: 2, highestSeverity: "blocker", correctionUsed: false },
  emissionGuard: {
    capacity: 8,
    seen: { hash: "concern" },
    order: ["hash"],
  },
  routing: {
    cancellationLatched: true,
    completedPrimaryTurns: 5,
    immunityUntilCompletedTurn: 6,
  },
  pendingReceipt: {
    ids: ["finding"],
    cancellationEpoch: 13,
    requestSequence: 17,
  },
  reportedFailures: ["provider"],
  reportedDiagnostics: ["diagnostic"],
});

test("session initialization resets session state without rewinding advanced generations", () => {
  const current = advancedState();
  const config = resolvedAdvisorConfig({ provider: "next", model: "model-next" });
  const next = initializeAdvisorSession(current, config);

  expect(next).toEqual({
    ...initialAdvisorApplicationState(config),
    epoch: current.epoch,
    cancellationEpoch: current.cancellationEpoch,
  });
});

test("a genuine user request advances each request generation once and preserves findings", () => {
  const current = advancedState();
  const next = beginAdvisorUserRequest(current);

  expect(next).toMatchObject({
    epoch: 7,
    cancellationEpoch: 14,
    parentTurnId: 11,
    requestSequence: 18,
    activeTrajectory: undefined,
    pendingPersistentRecovery: undefined,
    pendingReceipt: undefined,
    findingDedupe: { capacity: 8, order: [] },
    interventionBudget: { delivered: 0, correctionUsed: false },
    emissionGuard: { capacity: 8, order: [] },
    routing: {
      cancellationLatched: false,
      completedPrimaryTurns: 5,
      immunityUntilCompletedTurn: 6,
    },
  });
  expect(next.findingLifecycle).toBe(current.findingLifecycle);
});

test("request cancellation advances only cancellation and rolls recovery back once", () => {
  const current = advancedState();
  const next = cancelAdvisorRequest(current);

  expect(next).toMatchObject({
    epoch: 7,
    cancellationEpoch: 14,
    parentTurnId: 11,
    requestSequence: 17,
    pendingPersistentRecovery: undefined,
    pendingReceipt: undefined,
    findingDedupe: { scope: "scope", order: [] },
    emissionGuard: { order: [] },
    interventionBudget: {
      delivered: 1,
      highestSeverity: "concern",
      correctionUsed: true,
    },
    routing: { cancellationLatched: true },
  });
});

test("a committed config invalidates work without changing session or request IDs", () => {
  const advanced = advancedState();
  const current = {
    ...advanced,
    routing: { ...advanced.routing, cancellationLatched: false },
  };
  const disabled = resolvedAdvisorConfig({ enabled: false });
  const next = commitAdvisorConfig(current, disabled);

  expect(next).toMatchObject({
    config: disabled,
    epoch: 7,
    cancellationEpoch: 14,
    parentTurnId: 11,
    requestSequence: 17,
    pendingPersistentRecovery: undefined,
    findingLifecycle: { records: [] },
    findingDedupe: { capacity: 8, order: [] },
    interventionBudget: { delivered: 0, correctionUsed: false },
    emissionGuard: { capacity: 8, order: [] },
    routing: { cancellationLatched: true },
  });

  const modelChange = commitAdvisorConfig(
    current,
    resolvedAdvisorConfig({ provider: "next", model: "model-next" }),
  );
  expect(modelChange.routing.cancellationLatched).toBe(false);
});

test("the request-domain reset changes policy only", () => {
  const current = advancedState();
  const next = resetAdvisorRequestDomain(current);

  expect(next).toMatchObject({
    epoch: 7,
    cancellationEpoch: 13,
    parentTurnId: 11,
    requestSequence: 17,
    findingDedupe: { capacity: 8, order: [] },
    interventionBudget: { delivered: 0, correctionUsed: false },
    emissionGuard: { capacity: 8, order: [] },
  });
  expect(next.activeTrajectory).toBe(current.activeTrajectory);
  expect(next.pendingPersistentRecovery).toBe(current.pendingPersistentRecovery);
  expect(next.findingLifecycle).toBe(current.findingLifecycle);
  expect(next.routing).toBe(current.routing);
  expect(next.pendingReceipt).toBe(current.pendingReceipt);
});

test("recovery settlement rejects a different pending identity", () => {
  const current = advancedState();
  const expected = { ...current.pendingPersistentRecovery! };
  expect(settleAdvisorPendingRecovery(current, expected, "none")).toBe(current);
});

test("recovery guidance keeps delivery state and acknowledges the intervention", () => {
  const current = advancedState();
  const expected = current.pendingPersistentRecovery!;
  const next = settleAdvisorPendingRecovery(current, expected, "guidance");

  expect(next.pendingPersistentRecovery).toBeUndefined();
  expect(next.findingDedupe).toBe(current.findingDedupe);
  expect(next.emissionGuard).toBe(current.emissionGuard);
  expect(next.interventionBudget).toBe(current.interventionBudget);
  expect(next.findingLifecycle.records[0]?.status).toBe("acknowledged");
  expect(next.pendingReceipt?.ids).toEqual(["finding", "finding-id"]);
  expect(next.routing.immunityUntilCompletedTurn).toBe(8);
});

test("card-only recovery retains delivery state without acknowledging findings", () => {
  const current = { ...advancedState(), pendingReceipt: undefined };
  const expected = current.pendingPersistentRecovery!;
  const next = settleAdvisorPendingRecovery(current, expected, "card-only");

  expect(next.pendingPersistentRecovery).toBeUndefined();
  expect(next.findingDedupe).toBe(current.findingDedupe);
  expect(next.emissionGuard).toBe(current.emissionGuard);
  expect(next.interventionBudget).toBe(current.interventionBudget);
  expect(next.findingLifecycle.records[0]?.status).toBe("open");
  expect(next.pendingReceipt).toBeUndefined();
});

test("undelivered recovery rolls back hashes and budget while consuming correction", () => {
  const current = { ...advancedState(), pendingReceipt: undefined };
  const expected = current.pendingPersistentRecovery!;
  const next = settleAdvisorPendingRecovery(current, expected, "none");

  expect(next).toMatchObject({
    pendingPersistentRecovery: undefined,
    findingDedupe: { scope: "scope", order: [] },
    emissionGuard: { order: [] },
    interventionBudget: {
      delivered: 1,
      highestSeverity: "concern",
      correctionUsed: true,
    },
    findingLifecycle: { records: [{ status: "open" }] },
    pendingReceipt: undefined,
  });
});
