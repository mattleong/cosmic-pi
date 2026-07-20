// Resource lifecycle assertions.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { makeCapturedLogger, makeCapturedTracer } from "pi-cosmic-core/testing";
import { ShikiAdapter, ShikiBoundaryError, type ShikiHighlighter } from "../boundary/shiki";
import { codePreviewSettings, setCodePreviewSettings } from "../settings";
import { CodePreviewSyntaxService, isExactShikiCacheHit } from "./service";

const highlighter = (dispose: () => void) =>
  ({
    dispose,
    codeToTokensBase: (code: string) => [[{ content: code, color: "#ffffff" }]],
  }) as unknown as ShikiHighlighter;

describe("session syntax service", () => {
  it.effect("treats hashes as indexes and exact source as identity", () =>
    Effect.sync(() => {
      const cached = { source: "first" };
      assert.equal(isExactShikiCacheHit(cached, "first"), true);
      assert.equal(isExactShikiCacheHit(cached, "hash-collision"), false);
    }),
  );
  it.effect("shares initialization and captures a redacted resource span", () => {
    const captured = makeCapturedTracer();
    let created = 0;
    let disposed = 0;
    const adapter = ShikiAdapter.of({
      create: () =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              created++;
              return highlighter(() => disposed++);
            }),
          ),
        ),
      loadLanguage: () => Effect.void,
    });
    return Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      const service = yield* CodePreviewSyntaxService;
      yield* Effect.all(
        [service.initialize("secret-theme-path"), service.initialize("secret-theme-path")],
        {
          concurrency: "unbounded",
        },
      );
      assert.equal(created, 1);
      assert.equal(service.status().initialized, true);
      assert.ok(captured.spans.some((span) => span.name === "pi-code-previews.shiki.initialize"));
      assert.equal(
        JSON.stringify(
          captured.spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
        ).includes("secret-theme-path"),
        false,
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
          captured.layer,
        ),
      ),
      Effect.ensuring(Effect.sync(() => assert.equal(disposed, 1))),
    );
  });

  it.effect("logs only a redacted actionable Shiki degradation", () => {
    setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
    const captured = makeCapturedLogger();
    const adapter = ShikiAdapter.of({
      create: () =>
        Effect.fail(
          new ShikiBoundaryError({
            operation: "initialize",
            message: "secret-theme /secret/path sk-secret",
          }),
        ),
      loadLanguage: () => Effect.void,
    });
    return CodePreviewSyntaxService.use((service) => service.initialize("secret-theme")).pipe(
      Effect.provide(
        Layer.merge(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
          captured.layer,
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const telemetry = JSON.stringify(captured.entries);
          assert.match(telemetry, /Shiki failed to initialize/);
          assert.equal(telemetry.includes("secret-theme"), false);
          assert.equal(telemetry.includes("secret\/path"), false);
          assert.equal(telemetry.includes("sk-secret"), false);
        }),
      ),
    );
  });

  it.effect("interrupts in-flight initialization", () => {
    let interrupted = 0;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const adapter = ShikiAdapter.of({
        create: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => interrupted++)),
          ),
        loadLanguage: () => Effect.void,
      });
      const effect = CodePreviewSyntaxService.use((service) =>
        service.initialize("dark-plus"),
      ).pipe(
        Effect.provide(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
        ),
      );
      const fiber = yield* effect.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.equal(interrupted, 1);
    }).pipe(Effect.scoped);
  });
});
