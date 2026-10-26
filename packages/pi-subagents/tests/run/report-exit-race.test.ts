import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import type { BackendEvent } from "../../src/backend/model.ts";
import { assignmentOperations } from "../../src/run/assignment.ts";
import { SubagentProcessError } from "../../src/run/errors.ts";
import { backendEventHandler } from "../../src/run/events.ts";
import { notificationDelivery } from "../../src/run/notification-delivery.ts";
import { notificationHandoff } from "../../src/run/notification-handoff.ts";
import { settlementOperations } from "../../src/run/settlement.ts";
import type { ReportArchive } from "../../src/boundary/report-archive.ts";
import type { WithRunLock } from "../../src/run/internal.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import { view } from "../fixtures/run-view.ts";
import {
  backendHandleFixture,
  gatedReportArchive,
  makeRunContext,
  runRecordFixture,
  runningAssignment,
} from "./fixtures/run-context.ts";

const REPORT = "Accepted supervisor report.";
const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 25; turn += 1) yield* Effect.yieldNow;
});
const lateEvents: ReadonlyArray<BackendEvent> = [
  { type: "exit", exitCode: 0, diagnostic: "Process exited after reporting." },
  { type: "protocol_error", message: "Transport closed." },
];

const settlementFixture = (phase: "issuing" | "running", archiveReport?: ReportArchive) =>
  Effect.gen(function* () {
    const context = yield* makeRunContext();
    const record = yield* runRecordFixture({
      view: view({ state: phase === "issuing" ? "starting" : "running" }),
      process: yield* backendHandleFixture(),
      assignment: { ...runningAssignment(1), phase },
    });
    const completionGate = yield* Semaphore.make(1);
    const delivery = yield* notificationDelivery({
      ...context,
      withCompletionGate: completionGate.withPermits(1),
      handoff: notificationHandoff(context.records),
      notify: () => Effect.succeed({ deliveredCompletionKeys: [] }),
    });
    const settlement = settlementOperations({
      ...context,
      delivery,
      closeRecordScope: () => Effect.void,
      claimTurnInputDrain: (_record, drained) => Deferred.doneUnsafe(drained, Effect.void),
      ...(archiveReport && { archiveReport }),
    });
    const handleEvent = backendEventHandler({
      settlement,
      queueQuestionLocked: () => undefined,
      onProxyEvent: () => Effect.void,
    });
    return { context, record, settlement, handleEvent };
  });

describe("report ownership while its file is saved", () => {
  for (const lateEvent of lateEvents) {
    it.effect(`keeps a settled report ahead of ${lateEvent.type} during its file save`, () =>
      Effect.gen(function* () {
        const gate = yield* gatedReportArchive;
        const { record, settlement, handleEvent } = yield* settlementFixture(
          "running",
          gate.archive,
        );
        const settling = yield* settlement
          .runSettledFromBackend(record, 1, { stopReason: "stop", text: REPORT })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(gate.entered);
        const handling = yield* handleEvent(record, lateEvent).pipe(Effect.forkScoped);
        yield* yieldTurns;
        // The late event waits for the report's settlement instead of failing the run.
        expect(record.view.state).not.toBe("failed");
        expect(record.completionGenerations.size).toBe(0);
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(settling);
        yield* Fiber.join(handling);

        expect(record.view).toMatchObject({
          state: "completed",
          finalText: REPORT,
          reportGeneration: 1,
          reportArchive: { path: "/archive/1.md" },
        });
        expect([...record.completionGenerations.values()]).toMatchObject([
          { generation: 1, outcome: "completed", finalText: REPORT },
        ]);
        expect(gate.discarded).toEqual([]);
      }),
    );
  }
});

describe("report ownership at assignment activation", () => {
  for (const operation of ["start", "resume", "uncertain-resume"] as const)
    it.effect(`sends peer notices before ${operation} cleanup, whatever its caller does`, () =>
      Effect.gen(function* () {
        const steps = { noticesStarted: false, noticesFinished: false, cleanupStarted: false };
        const noticesGate = yield* Deferred.make<void>();
        const cleanupGate = yield* Deferred.make<void>();
        const cleanupDone = yield* Deferred.make<void>();
        const context = yield* makeRunContext({
          sendPeerNotices: () =>
            Effect.sync(() => void (steps.noticesStarted = true)).pipe(
              Effect.andThen(Deferred.await(noticesGate)),
              Effect.andThen(Effect.sync(() => void (steps.noticesFinished = true))),
            ),
        });
        const record = yield* runRecordFixture({
          view: view({ state: "starting" }),
          process: yield* backendHandleFixture(),
          assignment: {
            ...runningAssignment(1),
            phase: "issuing",
            startedObserved: operation === "uncertain-resume",
          },
        });
        const completionGate = yield* Semaphore.make(1);
        const delivery = yield* notificationDelivery({
          ...context,
          withCompletionGate: completionGate.withPermits(1),
          handoff: notificationHandoff(context.records),
          notify: () => Effect.succeed({ deliveredCompletionKeys: [] }),
        });
        // The caller that commits the completion pauses once it releases the lock, so the test
        // can interrupt it while the work it handed over is still running.
        const committed = yield* Deferred.make<void>();
        const callerGate = yield* Deferred.make<void>();
        let paused = false;
        const pauseAfterCommit: WithRunLock = (effect) =>
          context.withLock(effect).pipe(
            Effect.tap(() => {
              if (paused || record.view.state !== "completed") return Effect.void;
              paused = true;
              return Deferred.succeed(committed, undefined).pipe(
                Effect.andThen(Deferred.await(callerGate)),
              );
            }),
          );
        const settlement = settlementOperations({
          ...context,
          withLock: pauseAfterCommit,
          delivery,
          closeRecordScope: () =>
            Effect.sync(() => void (steps.cleanupStarted = true)).pipe(
              Effect.andThen(Deferred.await(cleanupGate)),
              Effect.andThen(
                context.withLock(
                  Effect.sync(() => {
                    record.process = undefined;
                    record.cleanupDisposition = "confirmed";
                  }),
                ),
              ),
              Effect.andThen(Deferred.succeed(cleanupDone, undefined)),
              Effect.asVoid,
            ),
          claimTurnInputDrain: (_record, drained) => Deferred.doneUnsafe(drained, Effect.void),
        });
        const assignments = assignmentOperations({
          ...context,
          startPrompt: () => Effect.void,
          activateAssignmentLocked: settlement.activateAssignmentLocked,
          replayAssignmentActivation: settlement.replayAssignmentActivation,
        });
        // The child settled before its start was confirmed, so the settlement is held.
        yield* settlement.runSettledFromBackend(record, 1, { stopReason: "stop", text: REPORT });
        expect(record.view.state).toBe("starting");
        const confirmation =
          operation === "uncertain-resume"
            ? assignments.retainUncertainAssignment(
                record,
                record.assignment.attemptToken,
                "Resume outcome remains uncertain.",
              )
            : assignments
                .submitPrompt(record, "Task", operation, record.assignment.attemptToken)
                .pipe(Effect.asVoid);
        const confirming = yield* confirmation.pipe(Effect.forkScoped);
        yield* Effect.gen(function* () {
          yield* Deferred.await(committed);
          expect(record.view).toMatchObject({
            state: "completed",
            finalText: REPORT,
            reportGeneration: 1,
          });
          expect([...record.completionGenerations.values()]).toMatchObject([
            { generation: 1, outcome: "completed", finalText: REPORT },
          ]);
          expect(record.cleanupDisposition).toBe("pending");
          yield* yieldUntil(() => steps.noticesStarted);
          yield* yieldTurns;
          expect(steps.cleanupStarted).toBe(false);

          // Interrupting the caller abandons neither the peer notices nor the cleanup after them.
          yield* Fiber.interrupt(confirming);
          yield* yieldTurns;
          expect(steps.cleanupStarted).toBe(false);
          yield* Deferred.succeed(noticesGate, undefined);
          yield* yieldUntil(() => steps.cleanupStarted);
          expect(steps.noticesFinished).toBe(true);
          yield* Deferred.succeed(cleanupGate, undefined);
          yield* Deferred.await(cleanupDone);
          expect(record.cleanupDisposition).toBe("confirmed");
          expect(record.view.state).toBe("completed");
          expect(record.completionGenerations.size).toBe(1);
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(callerGate, undefined),
              Deferred.succeed(noticesGate, undefined),
              Deferred.succeed(cleanupGate, undefined),
            ]),
          ),
        );
      }),
    );

  it.effect("answers an uncertain start that its own events settled first", () =>
    Effect.gen(function* () {
      const { context, record, settlement } = yield* settlementFixture("issuing");
      // The child settled before the start's response, which was lost, so the settlement waits.
      yield* settlement.runSettledFromBackend(record, 1, { stopReason: "stop", text: REPORT });
      expect(record.view.state).toBe("starting");
      let started = false;
      const assignments = assignmentOperations({
        ...context,
        // The child's start event arrives once the start is marked uncertain, activating the
        // assignment and replaying its settlement before the failed start is answered.
        withLock: (effect) =>
          context.withLock(effect).pipe(
            Effect.tap(() => {
              if (started) return Effect.void;
              started = true;
              return settlement.runStartedFromBackend(record, 1);
            }),
          ),
        startPrompt: () =>
          Effect.fail(
            SubagentProcessError.make({
              operation: "start",
              code: "prompt_outcome_uncertain",
              message: "Prompt response lost.",
            }),
          ),
        activateAssignmentLocked: settlement.activateAssignmentLocked,
        replayAssignmentActivation: settlement.replayAssignmentActivation,
      });
      const issued = yield* assignments.submitPrompt(
        record,
        "Task",
        "start",
        record.assignment.attemptToken,
      );
      expect(issued).toMatchObject({ state: "completed", finalText: REPORT, reportGeneration: 1 });
      expect(record.completionGenerations.size).toBe(1);
    }),
  );
});
