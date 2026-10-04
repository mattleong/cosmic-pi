import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { SubagentRuntimeClosedError } from "../../src/run/errors.ts";
import {
  makeWorkflowAdmissionQueue,
  makeWorkflowCapacity,
  makeWorkflowWaitOrder,
  type WorkflowQueued,
  type WorkflowWait,
} from "../../src/workflow/admission-queue.ts";
import { nativeReportRequest } from "../run/fixtures/service-harness.ts";
import { fakeAdmissionSignal } from "./fixtures/workflow-harness.ts";

/** A queue that grants as many waiters as `room` leaves beside the grants held. */
const roomQueue = () => {
  const state = { room: 0 };
  const queue = makeWorkflowAdmissionQueue<WorkflowQueued & { readonly label: string }>(
    (_waiting, granted) => Effect.sync(() => Math.max(0, state.room - granted.length)),
  );
  return { state, queue };
};

const patient: WorkflowWait = { onWait: Effect.void, abort: Effect.never };

describe("workflow admission queue", () => {
  it.effect("grants waiters in queue order and alternates runs at equal queue times", () =>
    Effect.gen(function* () {
      const { state, queue } = roomQueue();
      const granted: string[] = [];
      let waiting = 0;
      const wait: WorkflowWait = {
        onWait: Effect.sync(() => void (waiting += 1)),
        abort: Effect.never,
      };
      const finish = new Map<string, Deferred.Deferred<void>>();
      const first = makeWorkflowWaitOrder(1);
      const second = makeWorkflowWaitOrder(2);
      // The second run's calls arrive first, all queued at the same time as the first run's.
      const calls = [
        ...[0, 1, 2].map((index) => ({ label: `b${index}`, order: second(0) })),
        ...[0, 1, 2].map((index) => ({ label: `a${index}`, order: first(0) })),
        { label: "late", order: first(5) },
      ];
      for (const call of calls) {
        const done = yield* Deferred.make<void>();
        finish.set(call.label, done);
        yield* queue
          .hold(
            call,
            wait,
            Effect.sync(() => void granted.push(call.label)).pipe(
              Effect.andThen(Deferred.await(done)),
            ),
          )
          .pipe(Effect.forkChild);
      }
      yield* yieldUntil(() => waiting === calls.length);
      expect(granted).toEqual([]);
      state.room = 1;
      yield* queue.pump;
      for (let count = 1; count <= calls.length; count++) {
        yield* yieldUntil(() => granted.length === count);
        yield* Deferred.succeed(finish.get(granted.at(-1)!)!, undefined);
      }
      expect(granted).toEqual(["a0", "b0", "a1", "b1", "a2", "b2", "late"]);
    }),
  );

  it.effect("leaves cleanly when a waiter is interrupted or its wait is aborted", () =>
    Effect.gen(function* () {
      const { state, queue } = roomQueue();
      const order = makeWorkflowWaitOrder(1);
      const granted: string[] = [];
      const hold = (label: string, wait: WorkflowWait = patient) =>
        queue.hold(
          { label, order: order(0) },
          wait,
          Effect.sync(() => void granted.push(label)).pipe(Effect.andThen(Effect.never)),
        );
      state.room = 1;
      const holder = yield* hold("holder").pipe(Effect.forkChild);
      yield* yieldUntil(() => granted.length === 1);
      const interrupted = yield* hold("interrupted").pipe(Effect.forkChild);
      const abort = yield* Deferred.make<void>();
      const aborted = yield* hold("aborted", {
        onWait: Effect.void,
        abort: Deferred.await(abort),
      }).pipe(Effect.forkChild);
      const next = yield* hold("next").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(abort, undefined);
      expect(Option.isNone(yield* Fiber.join(aborted))).toBe(true);
      // Neither left a grant behind, so the next waiter takes the holder's place.
      yield* Fiber.interrupt(holder);
      yield* yieldUntil(() => granted.length === 2);
      expect(granted).toEqual(["holder", "next"]);
      yield* Fiber.interrupt(next);
    }),
  );

  it.effect("reports a waiter that has to wait, once", () =>
    Effect.gen(function* () {
      const { state, queue } = roomQueue();
      const order = makeWorkflowWaitOrder(1);
      let waits = 0;
      const wait: WorkflowWait = {
        onWait: Effect.sync(() => void (waits += 1)),
        abort: Effect.never,
      };
      state.room = 1;
      yield* queue.hold({ label: "free", order: order(0) }, wait, Effect.void);
      expect(waits).toBe(0);
      state.room = 0;
      const blocked = yield* queue
        .hold({ label: "blocked", order: order(1) }, wait, Effect.void)
        .pipe(Effect.forkChild);
      yield* yieldUntil(() => waits === 1);
      state.room = 1;
      yield* queue.pump;
      yield* Fiber.join(blocked);
      expect(waits).toBe(1);
    }),
  );
});

describe("workflow capacity queue", () => {
  const request = nativeReportRequest({ task: "review" });

  it.effect("grants a waiter when a release lands while the root checks it", () =>
    Effect.gen(function* () {
      const admission = fakeAdmissionSignal();
      let released = false;
      const capacity = yield* makeWorkflowCapacity({
        ...admission,
        queuedStartsAdmissible: (requests) =>
          Effect.sync(() => {
            if (released || requests.length === 0) return requests.length;
            // The slot is released while the root checks; nothing else wakes the queue.
            released = true;
            admission.releaseUnsafe();
            return 0;
          }),
      });
      const result = yield* capacity.hold(
        { order: makeWorkflowWaitOrder(1)(0), request, runId: "agent-1" },
        patient,
        Effect.succeed("started"),
      );
      expect(result).toEqual(Option.some("started"));
    }),
  );

  it.effect("fails its waiters once the subagent service closes", () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const capacity = yield* makeWorkflowCapacity({
        admissionRevision: Effect.succeed(0),
        waitForAdmissionChange: () =>
          Deferred.await(closed).pipe(
            Effect.andThen(
              Effect.fail(new SubagentRuntimeClosedError({ message: "Parent session shut down." })),
            ),
          ),
        queuedStartsAdmissible: () => Effect.succeed(0),
      });
      const order = makeWorkflowWaitOrder(1);
      const waiting = yield* capacity
        .hold({ order: order(0), request, runId: "agent-1" }, patient, Effect.void)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(closed, undefined);
      const exit = yield* Fiber.await(waiting);
      expect(Exit.isFailure(exit)).toBe(true);
      const later = yield* capacity
        .hold({ order: order(1), request, runId: "agent-2" }, patient, Effect.void)
        .pipe(Effect.flip);
      expect(later._tag).toBe("SubagentRuntimeClosedError");
    }),
  );
});
