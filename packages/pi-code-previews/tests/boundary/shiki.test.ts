import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import type { createHighlighter } from "shiki/bundle/full";

import {
  capturedTelemetrySnapshot,
  deferredPromise,
  makeCapturedLogger,
  provideBuiltLayer,
} from "pi-cosmic-core/testing";
import {
  createShikiHighlighter,
  disposeShikiHighlighter,
  ShikiAdapter,
  type ShikiHighlighter,
} from "../../src/boundary/shiki";
import { shikiHighlighterFixture } from "../support/shiki";

describe("Shiki adapter lifecycle", () => {
  it.effect("cancels pending implementation loading without creating an unowned highlighter", () =>
    Effect.gen(function* () {
      const implementation = deferredPromise<typeof createHighlighter>();
      const entered = yield* Deferred.make<void>();
      let created = false;
      const loading = yield* createShikiHighlighter("dark-plus", [], () => {
        Deferred.doneUnsafe(entered, Effect.void);
        return implementation.promise;
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(loading);
      implementation.resolve(() => {
        created = true;
        return Promise.resolve(shikiHighlighterFixture({}));
      });
      yield* Effect.promise(() => implementation.promise);
      yield* Effect.yieldNow;
      assert.equal(created, false);
    }).pipe(Effect.scoped),
  );

  it.effect("disposes creation that settles after cancellation without delaying shutdown", () =>
    Effect.gen(function* () {
      const creation = deferredPromise<ShikiHighlighter>();
      const entered = yield* Deferred.make<void>();
      const disposed = yield* Deferred.make<void>();
      let disposals = 0;
      const loading = yield* createShikiHighlighter("dark-plus", [], () =>
        Promise.resolve(() => {
          Deferred.doneUnsafe(entered, Effect.void);
          return creation.promise;
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(loading);
      creation.resolve(
        shikiHighlighterFixture({
          dispose: () => {
            disposals++;
            Deferred.doneUnsafe(disposed, Effect.void);
          },
        }),
      );
      yield* Deferred.await(disposed);
      assert.equal(disposals, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("translates a failed implementation load and allows later acquisition", () =>
    Effect.gen(function* () {
      const failed = yield* createShikiHighlighter("dark-plus", [], () =>
        Promise.reject(new Error("secret module path")),
      ).pipe(Effect.result);
      assert.ok(Result.isFailure(failed));
      assert.equal(failed.failure.operation, "initialize");
      assert.doesNotMatch(failed.failure.message, /secret module path/);
      let disposed = false;
      const expected = shikiHighlighterFixture({ dispose: () => (disposed = true) });
      const acquired = yield* createShikiHighlighter("dark-plus", [], () =>
        Promise.resolve(() => Promise.resolve(expected)),
      );
      assert.equal(acquired, expected);
      yield* disposeShikiHighlighter(acquired);
      assert.equal(disposed, true);
    }),
  );

  it.effect("defers disposal until a cancelled live language Promise settles", () => {
    const pending = deferredPromise();
    let loadStarted = false;
    let disposeAttempts = 0;
    const captured = makeCapturedLogger();
    const highlighter = shikiHighlighterFixture({
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
});
