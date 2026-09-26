// Test assertion boundary.
import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  deferredPromise,
  makeCapturedLogger,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import {
  disposeShikiHighlighter,
  disposeShikiHighlighterSafely,
  ShikiAdapter,
} from "../../src/boundary/shiki";

describe("Shiki adapter lifecycle", () => {
  it.effect("defers disposal until a cancelled live language Promise settles", () => {
    const pending = deferredPromise();
    let loadStarted = false;
    let disposeAttempts = 0;
    const captured = makeCapturedLogger();
    const highlighter = opaqueFixture({
      loadLanguage: () => {
        loadStarted = true;
        return pending.promise;
      },
      dispose: () => {
        disposeAttempts++;
        throw new Error("deferred third-party disposal failed");
      },
    });
    return Effect.gen(function* () {
      const load = yield* ShikiAdapter.live
        .loadLanguage(highlighter, "rust")
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(loadStarted, true);
      yield* Fiber.interrupt(load);
      yield* disposeShikiHighlighter(highlighter);
      assert.equal(disposeAttempts, 0);
      pending.resolve();
      yield* Effect.promise(() => pending.promise);
      yield* Effect.yieldNow;
      assert.equal(disposeAttempts, 1);
      assert.match(capturedTelemetrySnapshot(captured), /failed to dispose cleanly/);
      yield* disposeShikiHighlighter(highlighter);
      assert.equal(disposeAttempts, 1);
    }).pipe(Effect.scoped, provideBuiltLayer(captured.layer));
  });

  it.effect("late cancellation disposal cannot throw into a Promise continuation", () =>
    Effect.sync(() => {
      const highlighter = opaqueFixture({
        dispose: () => {
          throw new Error("third-party disposal failed");
        },
      });
      assert.equal(disposeShikiHighlighterSafely(highlighter), false);
    }),
  );
});
