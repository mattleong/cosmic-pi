import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  advisorStatusFramesEffect,
  makeAdvisorStatusService,
  type AdvisorStatusFrames,
  type AdvisorStatusStartOptions,
} from "../src/status/service.ts";

const statusOptions = (owner: string): AdvisorStatusStartOptions => ({
  owner,
  delayMs: 200,
  intervalMs: 120,
  animated: true,
  frameCount: 10,
  render: () => undefined,
});

it.effect("delays status, advances frames, and stops without a surviving timer fiber", () =>
  Effect.gen(function* () {
    const frames: number[] = [];
    const fiber = yield* advisorStatusFramesEffect(
      { delayMs: 200, intervalMs: 120, animated: true, frameCount: 10 },
      (frame) => frames.push(frame),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(199);
    expect(frames).toEqual([]);
    yield* TestClock.adjust(1);
    expect(frames).toEqual([0]);
    yield* TestClock.adjust(240);
    expect(frames).toEqual([0, 1, 2]);

    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust(1_000);
    expect(frames).toEqual([0, 1, 2]);
  }),
);

it.effect("renders a non-animated status exactly once", () =>
  Effect.gen(function* () {
    const frames: number[] = [];
    const fiber = yield* advisorStatusFramesEffect(
      { delayMs: 200, intervalMs: 120, animated: false, frameCount: 10 },
      (frame) => frames.push(frame),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(200);
    yield* Fiber.join(fiber);
    expect(frames).toEqual([0]);
  }),
);

it.effect("recovers when the initial status render throws", () =>
  Effect.gen(function* () {
    const fiber = yield* advisorStatusFramesEffect(
      { delayMs: 200, intervalMs: 120, animated: false, frameCount: 10 },
      () => {
        throw new Error("sensitive status renderer failure");
      },
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(200);
    yield* Fiber.join(fiber);
  }),
);

it.effect("keeps animating after a repeated-frame render throws", () =>
  Effect.gen(function* () {
    const attempts: number[] = [];
    const fiber = yield* advisorStatusFramesEffect(
      { delayMs: 200, intervalMs: 120, animated: true, frameCount: 10 },
      (frame) => {
        attempts.push(frame);
        if (frame === 1) throw new Error("sensitive animation failure");
      },
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust(200);
    yield* TestClock.adjust(240);
    expect(attempts).toEqual([0, 1, 2]);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("replaces the owned animation and preserves owner-matched settlement", () =>
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<never, void>();
    const firstStarted = yield* Deferred.make<void>();
    const firstStopped = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const secondStopped = yield* Deferred.make<void>();
    const frames: AdvisorStatusFrames = (options) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(
          options.owner === "first" ? firstStarted : secondStarted,
          undefined,
        );
        return yield* Effect.never;
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(options.owner === "first" ? firstStopped : secondStopped, undefined),
        ),
      );
    const service = yield* makeAdvisorStatusService({ fork: runFork }, frames);

    service.start(statusOptions("first"));
    yield* Deferred.await(firstStarted);
    service.start(statusOptions("second"));
    yield* Deferred.await(firstStopped);
    yield* Deferred.await(secondStarted);

    expect(service.settle("first")).toBe(false);
    expect(Option.isNone(yield* Deferred.poll(secondStopped))).toBe(true);
    expect(service.settle("second")).toBe(true);
    yield* Deferred.await(secondStopped);
  }),
);

it.effect("does not complete shutdown until the owned animation finalizer settles", () =>
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<never, void>();
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const frames: AdvisorStatusFrames = () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(stopped, undefined)),
      );
    const service = yield* makeAdvisorStatusService({ fork: runFork }, frames);

    service.start(statusOptions("owned"));
    yield* Deferred.await(started);
    yield* service.shutdown;

    expect(Option.isSome(yield* Deferred.poll(stopped))).toBe(true);
  }),
);
