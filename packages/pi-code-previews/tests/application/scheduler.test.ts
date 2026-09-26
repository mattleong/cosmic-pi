import { it } from "@effect/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  clearCodePreviewSessionCapability,
  deferCodePreview,
} from "../../src/application/capability";
import {
  CodePreviewSchedulerService,
  previewScheduleEffect,
} from "../../src/application/scheduler.ts";

it("no background work starts before acquisition or after shutdown", () => {
  clearCodePreviewSessionCapability();
  let calls = 0;
  deferCodePreview(() => calls++)();
  assert.equal(calls, 0);
});

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
  }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
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
      }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
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
      }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
    );
    if (!schedule) return yield* Effect.die("scheduler door was not captured");

    let ticks = 0;
    const stop = schedule(100, () => ticks++);
    yield* TestClock.adjust(500);
    assert.equal(ticks, 0);
    stop();
  }),
);

it.effect("a throwing host callback cannot terminate the repeating timing fiber", () =>
  Effect.gen(function* () {
    let ticks = 0;
    const fiber = yield* previewScheduleEffect(100, () => {
      ticks++;
      if (ticks === 1) throw new Error("host invalidation failed");
    }).pipe(Effect.forkScoped);
    yield* TestClock.adjust("500 millis");
    assert.equal(ticks, 5);
    assert.equal(fiber.pollUnsafe(), undefined);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped),
);
