// Test assertion boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { test } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  clearCodePreviewSessionCapability,
  deferCodePreview,
  previewScheduleEffect,
  scheduleCodePreview,
} from "../session-capability";
import { scheduleProjectedCodePreview } from "../session-projection";

test("no background work starts before acquisition or after shutdown", () => {
  clearCodePreviewSessionCapability();
  let calls = 0;
  const cancelDeferred = deferCodePreview(() => calls++);
  const cancelSchedule = scheduleCodePreview(1, () => calls++);
  const cancelProjectedSchedule = scheduleProjectedCodePreview(1, () => calls++);
  cancelDeferred();
  cancelSchedule();
  cancelProjectedSchedule();
  assert.equal(calls, 0);
});

describe("preview runtime clock", () => {
  it.effect("preview timing uses the Effect clock and stops when its scope is interrupted", () =>
    Effect.gen(function* () {
      let ticks = 0;
      const fiber = yield* previewScheduleEffect(100, () => ticks++).pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.equal(ticks, 5);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("1 second");
      assert.equal(ticks, 5);
    }).pipe(Effect.scoped),
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
});
