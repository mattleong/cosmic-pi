import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { deliverTerminalReport } from "../src/backend/terminal-report-delivery.ts";
import type { BackendEvent } from "../src/backend/model.ts";

const report: BackendEvent = {
  type: "report",
  runId: "worker",
  assignmentEpoch: 1,
  sequence: 1,
  deliveryId: "delivery",
  text: "Done",
};

describe("terminal report transfer", () => {
  it.effect("retains a blocked terminal transfer beyond the former timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(1);
        yield* Queue.offer(events, { type: "activity", assignmentEpoch: 1 });
        yield* deliverTerminalReport(
          events,
          Queue.offer(events, report).pipe(Effect.asVoid),
          scope,
        );
        yield* TestClock.adjust("1200 millis");
        expect(yield* Stream.runCollect(Stream.fromQueue(events))).toEqual([
          { type: "activity", assignmentEpoch: 1 },
          report,
        ]);
      }),
    ),
  );

  it.effect("shutdown interrupts a stalled transfer and ends ingress without a consumer", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const events = yield* Queue.bounded<BackendEvent, Cause.Done>(1);
      const started = Deferred.makeUnsafe<void>();
      const interrupted = Deferred.makeUnsafe<void>();
      yield* Queue.offer(events, { type: "activity", assignmentEpoch: 1 });
      yield* deliverTerminalReport(
        events,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Queue.offer(events, report)),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          Effect.asVoid,
        ),
        scope,
      );
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(interrupted);
      expect(yield* Stream.runCollect(Stream.fromQueue(events))).toEqual([
        { type: "activity", assignmentEpoch: 1 },
      ]);
    }),
  );
});
