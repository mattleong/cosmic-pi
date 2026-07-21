import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { advisorStatusFramesEffect } from "../src/status-service.ts";

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
