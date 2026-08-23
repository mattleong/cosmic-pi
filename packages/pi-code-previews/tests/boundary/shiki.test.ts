// Test assertion boundary.
import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import {
  disposeShikiHighlighter,
  disposeShikiHighlighterSafely,
  ShikiAdapter,
  ShikiBoundaryError,
  type ShikiHighlighter,
} from "../../src/boundary/shiki";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { getShikiStatus } from "../../src/syntax/render";
import { disposeShikiEffect, initializeShikiEffect } from "../../src/syntax/shiki";
import { CodePreviewSyntaxService } from "../../src/syntax/service";

const highlighterFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ShikiHighlighter => {
  // SAFETY: Each scenario invokes only the Shiki members implemented by its fixture.
  return fixture as Fixture & ShikiHighlighter;
};

describe("Shiki adapter lifecycle", () => {
  it.effect("defers disposal until a cancelled live language Promise settles", () => {
    const pendingGate = Deferred.makeUnsafe<void>();
    const pending = Effect.runPromise(Deferred.await(pendingGate));
    let loadStarted = false;
    let disposeAttempts = 0;
    const captured = makeCapturedLogger();
    const highlighter = highlighterFixture({
      loadLanguage: () => {
        loadStarted = true;
        return pending;
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
      Deferred.doneUnsafe(pendingGate, Effect.void);
      yield* Effect.promise(() => pending);
      yield* Effect.yieldNow;
      assert.equal(disposeAttempts, 1);
      assert.match(capturedTelemetrySnapshot(captured), /failed to dispose cleanly/);
      yield* disposeShikiHighlighter(highlighter);
      assert.equal(disposeAttempts, 1);
    }).pipe(Effect.scoped, provideBuiltLayer(captured.layer));
  });

  it.effect("late cancellation disposal cannot throw into a Promise continuation", () =>
    Effect.sync(() => {
      const highlighter = highlighterFixture({
        dispose: () => {
          throw new Error("third-party disposal failed");
        },
      });
      assert.equal(disposeShikiHighlighterSafely(highlighter), false);
    }),
  );

  it.effect("degrades typed initialization failures to plain text", () => {
    const adapter = ShikiAdapter.of({
      create: () =>
        Effect.fail(
          new ShikiBoundaryError({ operation: "initialize", message: "controlled failure" }),
        ),
      loadLanguage: () => Effect.void,
    });
    return Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      yield* disposeShikiEffect;
      yield* initializeShikiEffect("dark-plus");
      assert.equal(getShikiStatus().initialized, false);
    }).pipe(
      provideBuiltLayer(
        CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
      ),
    );
  });

  it.effect("runs adapter finalization when initialization is interrupted", () => {
    let released = 0;
    const adapter = ShikiAdapter.of({
      create: () => Effect.never.pipe(Effect.ensuring(Effect.sync(() => released++))),
      loadLanguage: () => Effect.void,
    });
    return Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      const fiber = yield* initializeShikiEffect("dark-plus").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.equal(released, 1);
    }).pipe(
      Effect.scoped,
      provideBuiltLayer(
        CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
      ),
    );
  });
});
