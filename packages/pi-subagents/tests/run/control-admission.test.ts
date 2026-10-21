import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Fiber from "effect/Fiber";
import { controlOperations, type RunControlMessage } from "../../src/run/control.ts";
import { captureSubagentControlExpectation } from "../../src/run/model.ts";
import { processControlOperations } from "../../src/run/process-lifecycle.ts";
import { subtreeStopper } from "../../src/run/subtree-stop.ts";
import { turnInputGates } from "../../src/run/turn-input.ts";
import { view } from "../fixtures/run-view.ts";
import {
  backendHandleFixture,
  makeRunContext,
  runningAssignment,
  runRecordFixture,
} from "./fixtures/run-context.ts";
import { localServiceFixture, request, runView, withService } from "./fixtures/service-harness.ts";

const userMessage = (text: string): RunControlMessage => ({
  answer: text,
  guidance: text,
  recordNoticeLocked: () => undefined,
});

const fixture = Effect.gen(function* () {
  const deliveries: string[] = [];
  const handle = yield* backendHandleFixture();
  const record = yield* runRecordFixture({
    view: view(),
    assignment: runningAssignment(1),
    process: {
      ...handle,
      controls: {
        ...handle.controls,
        reply: (id, message) => Effect.sync(() => void deliveries.push(`${id}: ${message}`)),
        steer: () => Effect.sync(() => void deliveries.push("guidance")),
        interrupt: Effect.sync(() => void deliveries.push("interrupt")),
      },
    },
  });
  const context = yield* makeRunContext({ records: new Map([[record.view.id, record]]) });
  const waiting = yield* Deferred.make<void>();
  const withLock: typeof context.withLock = (effect) =>
    Deferred.succeed(waiting, undefined).pipe(Effect.andThen(context.withLock(effect)));
  const controls = controlOperations({
    ...context,
    withLock,
    ...turnInputGates(withLock),
    processControls: processControlOperations(withLock),
    closeRecordScope: () => Effect.sync(() => void deliveries.push("stop")),
    verifyCleanup: () => Effect.void,
    settle: () => Effect.die("Unexpected settlement"),
  });
  return { context, controls, deliveries, record, waiting, withLock };
});

describe("captured fleet control authority", () => {
  it.effect("rejects a reply when another question replaces it while admission waits", () =>
    Effect.gen(function* () {
      const { context, controls, deliveries, record, waiting } = yield* fixture;
      record.view = {
        ...record.view,
        state: "waiting_for_parent",
        question: { requestId: "old-question", message: "Change directory A?" },
      };
      const expected = captureSubagentControlExpectation(record.view);
      const pending = yield* context.withLock(
        Effect.gen(function* () {
          const replying = yield* controls
            .deliver(record.view.id, userMessage("Yes"), expected)
            .pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(waiting);
          record.view = {
            ...record.view,
            question: { requestId: "new-question", message: "Delete directory B?" },
          };
          return replying;
        }),
      );
      expect(yield* Fiber.join(pending)).toMatchObject({ code: "run_control_changed" });
      expect(deliveries).toEqual([]);
      expect(record.replyPendingRequestId).toBeUndefined();
      expect(record.view.question?.requestId).toBe("new-question");

      yield* controls.deliver(
        record.view.id,
        userMessage("No"),
        captureSubagentControlExpectation(record.view),
      );
      expect(deliveries).toEqual(["new-question: No"]);
    }).pipe(Effect.scoped),
  );

  for (const action of ["send", "interrupt", "rename", "stop", "stop subtree"] as const)
    it.effect(`rejects queued ${action} after a new assignment takes over`, () =>
      Effect.gen(function* () {
        const { context, controls, deliveries, record, waiting, withLock } = yield* fixture;
        const expected = captureSubagentControlExpectation(record.view);
        const stopSubtree = subtreeStopper({ ...context, withLock, stopRun: controls.stop });
        const control = Match.value(action).pipe(
          Match.when("send", () =>
            controls.deliver(record.view.id, userMessage("Old guidance"), expected),
          ),
          Match.when("rename", () => controls.rename(record.view.id, "Old name", expected)),
          Match.when("stop subtree", () => stopSubtree(record.view.id, expected)),
          Match.orElse((other) => controls[other](record.view.id, expected)),
        );
        const pending = yield* context.withLock(
          Effect.gen(function* () {
            const queued = yield* control.pipe(Effect.flip, Effect.forkScoped);
            yield* Deferred.await(waiting);
            record.assignment = runningAssignment(2);
            record.view = { ...record.view, assignmentEpoch: 2 };
            return queued;
          }),
        );
        expect(yield* Fiber.join(pending)).toMatchObject({ code: "run_control_changed" });
        expect(deliveries).toEqual([]);
        expect(record.view.state).toBe("running");
        expect(record.view.name).toBe("auth-review");
        expect(record.pauseRequested).toBe(false);
        expect(record.stoppedByParent).toBe(false);
        expect(record.cleanupPending).toBe(false);
      }).pipe(Effect.scoped),
    );

  it.effect("rejects a stale resume even after the same process returns to paused", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const paused = yield* service.interrupt(run.id);
      const expected = captureSubagentControlExpectation(paused);
      const resumed = yield* service.resume(run.id, undefined, expected);
      expect(resumed.assignmentEpoch).toBeGreaterThan(paused.assignmentEpoch);
      const pausedAgain = yield* service.interrupt(run.id);
      expect(pausedAgain.sessionId).toBe(paused.sessionId);
      expect(pausedAgain.reportGeneration).toBe(paused.reportGeneration);
      expect(
        yield* service.resume(run.id, "Stale input", expected).pipe(Effect.flip),
      ).toMatchObject({
        code: "run_control_changed",
      });
      expect((yield* runView(service, run.id)).state).toBe("paused");
      expect((yield* service.resume(run.id)).state).toBe("running");
    });
  });
});
