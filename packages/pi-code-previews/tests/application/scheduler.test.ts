// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { it } from "@effect/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { CodePreviewSchedulerService } from "../../src/application/scheduler.ts";

it.effect("cancels scheduled callbacks synchronously while the session remains active", () =>
  Effect.gen(function* () {
    let ticks = 0;
    const service = yield* CodePreviewSchedulerService;
    const stop = service.schedule(100, () => ticks++);

    yield* TestClock.adjust(200);
    assert.equal(ticks, 2);
    stop();
    stop();
    yield* TestClock.adjust(500);
    assert.equal(ticks, 2);
  }).pipe(Effect.provide(CodePreviewSchedulerService.layer)),
);

it.effect("interrupts every scheduled callback before the scheduler scope closes", () =>
  Effect.gen(function* () {
    let ticks = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* CodePreviewSchedulerService;
        service.schedule(100, () => ticks++);
        yield* TestClock.adjust(100);
        assert.equal(ticks, 1);
      }).pipe(Effect.provide(CodePreviewSchedulerService.layer)),
    );

    yield* TestClock.adjust(500);
    assert.equal(ticks, 1);
  }),
);

it.effect("interrupts work started through a retained door after its session closes", () =>
  Effect.gen(function* () {
    let schedule: ((interval: number, task: () => void) => () => void) | undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        schedule = (yield* CodePreviewSchedulerService).schedule;
      }).pipe(Effect.provide(CodePreviewSchedulerService.layer)),
    );
    if (!schedule) return yield* Effect.die("scheduler door was not captured");

    let ticks = 0;
    const stop = schedule(100, () => ticks++);
    yield* TestClock.adjust(500);
    assert.equal(ticks, 0);
    stop();
  }),
);
