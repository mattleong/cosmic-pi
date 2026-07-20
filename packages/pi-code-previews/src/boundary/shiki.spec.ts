// Test assertion boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ShikiAdapter, ShikiBoundaryError } from "./shiki";
import { codePreviewSettings, setCodePreviewSettings } from "../settings";
import { disposeShikiEffect, getShikiStatus, initializeShikiEffect } from "../syntax/shiki";

describe("Shiki adapter lifecycle", () => {
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
    }).pipe(Effect.provide(Layer.succeed(ShikiAdapter, adapter)));
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
    }).pipe(Effect.scoped, Effect.provide(Layer.succeed(ShikiAdapter, adapter)));
  });
});
