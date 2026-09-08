import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalClaudeReportDelivery } from "../src/backend/local-claude-report-delivery.ts";
import type { BackendEvent } from "../src/backend/model.ts";

const report = {
  type: "report",
  runId: "claude-worker",
  assignmentEpoch: 7,
  sequence: 1,
  deliveryId: "report-delivery",
  text: "Completed work",
} as const;

const makeDelivery = Effect.gen(function* () {
  const events = yield* Queue.bounded<BackendEvent>(1);
  const entered = yield* Deferred.make<void>();
  const reports = makeLocalClaudeReportDelivery((event) =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Queue.offer(events, event)),
      Effect.asVoid,
    ),
  );
  return { reports, events, entered };
});

describe("Claude accepted report delivery", () => {
  it.effect("delivers once for either report/result order and only the matching epoch", () =>
    Effect.gen(function* () {
      for (const resultFirst of [false, true]) {
        const { reports, events } = yield* makeDelivery;
        if (resultFirst) yield* reports.observeNativeResult(report.assignmentEpoch);
        yield* reports.bufferAcceptedReport(report);
        if (!resultFirst) {
          yield* reports.observeNativeResult(report.assignmentEpoch - 1);
          expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
          yield* reports.observeNativeResult(report.assignmentEpoch);
        }
        expect(yield* Queue.take(events)).toEqual(report);
        yield* reports.bufferAcceptedReport(report);
        yield* reports.observeNativeResult(report.assignmentEpoch);
        yield* reports.forwardReport(report);
        yield* TestClock.adjust("10 seconds");
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
      }
    }),
  );

  it.effect("bounds missing-result grace to ten seconds", () =>
    Effect.gen(function* () {
      const { reports, events } = yield* makeDelivery;
      yield* reports.bufferAcceptedReport(report);
      yield* TestClock.adjust("9 seconds");
      expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(events)).toEqual(report);
      yield* reports.observeNativeResult(report.assignmentEpoch);
      expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
    }),
  );

  it.effect("cancels grace on scope close while retaining immediate recovery", () =>
    Effect.gen(function* () {
      const { reports, events } = yield* makeDelivery;
      yield* Effect.scoped(reports.bufferAcceptedReport(report));
      yield* TestClock.adjust("10 seconds");
      expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
      yield* reports.forwardReport(report);
      expect(yield* Queue.take(events)).toEqual(report);
    }),
  );

  it.effect("coalesces native-result, grace and immediate forwarding under backpressure", () =>
    Effect.gen(function* () {
      const { reports, events, entered } = yield* makeDelivery;
      const blocker: BackendEvent = { type: "activity", assignmentEpoch: 7 };
      yield* Queue.offer(events, blocker);
      yield* reports.bufferAcceptedReport(report);
      const nativeResult = yield* Effect.forkChild(reports.observeNativeResult(7));
      yield* Deferred.await(entered);
      const recovery = yield* Effect.forkChild(reports.forwardReport(report));
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(events)).toEqual(blocker);
      expect(yield* Queue.take(events)).toEqual(report);
      yield* Fiber.join(nativeResult);
      yield* Fiber.join(recovery);
      expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
    }),
  );

  it.effect("lets a waiting forwarder retry an interrupted owner's blocked enqueue", () =>
    Effect.gen(function* () {
      const { reports, events, entered } = yield* makeDelivery;
      const blocker: BackendEvent = { type: "activity", assignmentEpoch: 7 };
      yield* Queue.offer(events, blocker);
      const owner = yield* Effect.forkChild(reports.forwardReport(report));
      yield* Deferred.await(entered);
      const waiter = yield* Effect.forkChild(reports.forwardReport(report));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      expect(yield* Queue.take(events)).toEqual(blocker);
      yield* Fiber.join(waiter);
      expect(yield* Queue.take(events)).toEqual(report);
      yield* reports.forwardReport(report);
      expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
    }),
  );
});
