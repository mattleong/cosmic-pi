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

test("no background work starts before acquisition or after shutdown", () => {
  clearCodePreviewSessionCapability();
  let calls = 0;
  const cancelDeferred = deferCodePreview(() => calls++);
  const cancelSchedule = scheduleCodePreview(1, () => calls++);
  cancelDeferred();
  cancelSchedule();
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
});
