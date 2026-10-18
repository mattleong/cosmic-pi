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
import { settlementOperations } from "../../src/run/settlement.ts";
import { view } from "../fixtures/run-view.ts";
import {
  backendHandleFixture,
  makeRunContext,
  runRecordFixture,
  runningAssignment,
} from "./fixtures/run-context.ts";

const REPORT = "Accepted supervisor report.";
const lateEvents: ReadonlyArray<BackendEvent> = [
  { type: "exit", exitCode: 0, diagnostic: "Process exited after reporting." },
  {
    type: "backend_failure",
    error: new SubagentProcessError({ operation: "run", message: "Transport closed." }),
  },
];

describe("report ownership at assignment activation", () => {
  for (const operation of ["start", "resume", "uncertain-resume"] as const) {
    for (const lateEvent of lateEvents) {
      it.effect(`keeps a buffered ${operation} report ahead of post-lock ${lateEvent.type}`, () =>
        Effect.gen(function* () {
          const noticesStarted = yield* Deferred.make<void>();
          const noticesGate = yield* Deferred.make<void>();
          const context = yield* makeRunContext({
            sendPeerNotices: () =>
              Deferred.succeed(noticesStarted, undefined).pipe(
                Effect.andThen(Deferred.await(noticesGate)),
                Effect.asVoid,
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
            notify: () => Effect.succeed({ deliveredCompletionKeys: [] }),
          });
          const cleanupStarted = yield* Deferred.make<void>();
          const cleanupGate = yield* Deferred.make<void>();
          const cleanupDone = yield* Deferred.make<void>();
          const settlement = settlementOperations({
            ...context,
            delivery,
            closeRecordScope: () =>
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(cleanupGate)),
                Effect.andThen(
                  context.withLock(
                    Effect.sync(() => {
                      record.process = undefined;
                      record.cleanupPending = false;
                      record.cleanupDisposition = "confirmed";
                    }),
                  ),
                ),
                Effect.andThen(Deferred.succeed(cleanupDone, undefined)),
                Effect.asVoid,
              ),
            claimTurnInputDrain: (_record, drained) => Deferred.doneUnsafe(drained, Effect.void),
          });
          const activated = yield* Deferred.make<void>();
          const postLockGate = yield* Deferred.make<void>();
          const assignments = assignmentOperations({
            ...context,
            // Pause the actual prompt-confirmation caller immediately after releasing the lock.
            // Backend exit/failure and cancellation can then run before its post-lock continuation.
            withLock: (effect) =>
              context.withLock(effect).pipe(
                Effect.tap(() => Deferred.succeed(activated, undefined)),
                Effect.tap(() => Deferred.await(postLockGate)),
              ),
            startPrompt: () => Effect.void,
            activateAssignmentLocked: settlement.activateAssignmentLocked,
            replayAssignmentActivation: settlement.replayAssignmentActivation,
          });
          const handleEvent = backendEventHandler({
            settlement,
            queueQuestionLocked: () => undefined,
            onProxyEvent: () => Effect.void,
          });
          yield* settlement.acceptBackendReport(record, {
            runId: record.view.id,
            assignmentEpoch: 1,
            sequence: 1,
            deliveryId: "accepted",
            text: REPORT,
          });
          yield* settlement.runSettledFromBackend(record, 1, { stopReason: "error" });
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
            yield* Deferred.await(activated);
            yield* handleEvent(record, lateEvent);
            expect(record.view).toMatchObject({
              state: "completed",
              finalText: REPORT,
              reportGeneration: 1,
            });
            expect([...record.completionGenerations.values()]).toMatchObject([
              { generation: 1, outcome: "completed", finalText: REPORT },
            ]);
            expect(record.lastBackendReport?.deliveryId).toBe("accepted");
            expect(record.cleanupPending).toBe(true);
            yield* Deferred.await(noticesStarted);
            expect(yield* Deferred.isDone(cleanupStarted)).toBe(false);

            // Cancellation cannot abandon either peer notices or the following backend cleanup.
            yield* Fiber.interrupt(confirming);
            yield* Deferred.succeed(noticesGate, undefined);
            yield* Deferred.await(cleanupStarted);
            yield* Deferred.succeed(cleanupGate, undefined);
            yield* Deferred.await(cleanupDone);
            expect(record.cleanupDisposition).toBe("confirmed");
            expect(record.view.state).toBe("completed");
            expect(record.completionGenerations.size).toBe(1);
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(noticesGate, undefined).pipe(
                Effect.andThen(Deferred.succeed(cleanupGate, undefined)),
              ),
            ),
          );
        }),
      );
    }
  }
});
