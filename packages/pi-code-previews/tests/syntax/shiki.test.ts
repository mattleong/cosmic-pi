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
import {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  makeCapturedTracer,
} from "pi-cosmic-core/testing";
import { ShikiAdapter, ShikiBoundaryError, type ShikiHighlighter } from "../../src/boundary/shiki";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import {
  requestSyntaxInitialize,
  requestSyntaxLanguage,
  syntaxProjection,
} from "../../src/syntax/projection";
import { CodePreviewSyntaxService } from "../../src/syntax/service";
import { isExactShikiCacheHit } from "../../src/syntax/render";

const highlighter = (dispose: () => void) => {
  const fixture = {
    dispose,
    codeToTokensBase: (code: string) => [[{ content: code, color: "#ffffff" }]],
  };
  // SAFETY: Syntax tests invoke only dispose and codeToTokensBase on this fixture.
  return fixture as typeof fixture & ShikiHighlighter;
};

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
      assert.equal((yield* service.status).initialized, true);
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

  it.effect("rejects late initialization replacement and invokes language callbacks once", () =>
    Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      const first = yield* Deferred.make<ShikiHighlighter>();
      let firstDisposed = 0;
      let secondDisposed = 0;
      let languageLoads = 0;
      const adapter = ShikiAdapter.of({
        create: (theme) =>
          theme === "first"
            ? Deferred.await(first)
            : Effect.succeed(highlighter(() => secondDisposed++)),
        loadLanguage: () => Effect.sync(() => languageLoads++),
      });
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          const old = yield* service.initialize("first").pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* service.initialize("second");
          yield* Deferred.succeed(
            first,
            highlighter(() => firstDisposed++),
          );
          yield* Fiber.join(old);
          assert.equal(firstDisposed, 1);
          assert.equal(syntaxProjection()?.theme, "second");
          let callbacks = 0;
          requestSyntaxLanguage("rust", () => callbacks++);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.equal(languageLoads, 1);
          assert.equal(callbacks, 1);
          assert.equal(syntaxProjection()?.loadedLanguages.includes("rust"), true);
          requestSyntaxLanguage("rust", () => callbacks++);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.equal(languageLoads, 1);
          assert.equal(callbacks, 2);
        }),
      ).pipe(
        Effect.provide(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
        ),
      );
      assert.equal(secondDisposed, 1);
    }).pipe(Effect.scoped),
  );

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
          const telemetry = capturedTelemetrySnapshot(captured);
          assert.match(telemetry, /Shiki failed to initialize/);
          assert.equal(telemetry.includes("secret-theme"), false);
          assert.equal(telemetry.includes("secret\/path"), false);
          assert.equal(telemetry.includes("sk-secret"), false);
        }),
      ),
    );
  });

  it.effect("interrupted initialization clears its flight and permits retry", () => {
    let interrupted = 0;
    let creates = 0;
    return Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      const started = yield* Deferred.make<void>();
      const adapter = ShikiAdapter.of({
        create: () => {
          creates++;
          return creates === 1
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Effect.sync(() => interrupted++)),
              )
            : Effect.succeed(highlighter(() => undefined));
        },
        loadLanguage: () => Effect.void,
      });
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          const first = yield* service.initialize("dark-plus").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(first);
          yield* service.initialize("dark-plus");
          assert.equal(creates, 2);
          assert.equal(interrupted, 1);
          assert.equal((yield* service.status).initialized, true);
        }),
      ).pipe(
        Effect.provide(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
        ),
      );
    }).pipe(Effect.scoped);
  });

  it.effect("notifies every duplicate initialization request exactly once", () => {
    let callbacks = 0;
    let creates = 0;
    const adapter = ShikiAdapter.of({
      create: () =>
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() => {
              creates++;
              return highlighter(() => undefined);
            }),
          ),
        ),
      loadLanguage: () => Effect.void,
    });
    return CodePreviewSyntaxService.use(() =>
      Effect.gen(function* () {
        requestSyntaxInitialize("dark-plus", () => callbacks++);
        requestSyntaxInitialize("dark-plus", () => callbacks++);
        for (let attempt = 0; attempt < 10; attempt++) yield* Effect.yieldNow;
        assert.equal(creates, 1);
        assert.equal(callbacks, 2);
      }),
    ).pipe(
      Effect.provide(
        CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
      ),
    );
  });

  it.effect("bounds duplicate initialization ingress without losing invalidations", () => {
    const requests = 200;
    let callbacks = 0;
    let creates = 0;
    return Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const adapter = ShikiAdapter.of({
        create: () => {
          creates++;
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(highlighter(() => undefined)),
          );
        },
        loadLanguage: () => Effect.void,
      });
      yield* CodePreviewSyntaxService.use(() =>
        Effect.gen(function* () {
          for (let index = 0; index < requests; index++)
            requestSyntaxInitialize("dark-plus", () => callbacks++);
          yield* Deferred.await(started);
          assert.ok(callbacks > 0, "overflow callbacks should invalidate immediately");
          assert.ok(callbacks < requests, "bounded retained callbacks should await completion");
          yield* Deferred.succeed(release, undefined);
          for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
          assert.equal(creates, 1);
          assert.equal(callbacks, requests);
        }),
      ).pipe(
        Effect.provide(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
        ),
      );
    }).pipe(Effect.scoped);
  });

  it.effect("bounds duplicate language ingress and isolates invalidation failures", () => {
    const requests = 200;
    let callbacks = 0;
    let languageLoads = 0;
    return Effect.gen(function* () {
      setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const adapter = ShikiAdapter.of({
        create: () => Effect.succeed(highlighter(() => undefined)),
        loadLanguage: () => {
          languageLoads++;
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));
        },
      });
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          yield* service.initialize("dark-plus");
          for (let index = 0; index < requests; index++)
            requestSyntaxLanguage(
              "rust",
              index === 0
                ? () => {
                    throw new Error("host callback failure");
                  }
                : () => callbacks++,
            );
          yield* Deferred.await(started);
          assert.ok(callbacks > 0, "overflow callbacks should invalidate immediately");
          yield* Deferred.succeed(release, undefined);
          for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
          assert.equal(languageLoads, 1);
          assert.equal(callbacks, requests - 1);
          assert.equal(syntaxProjection()?.loadedLanguages.includes("rust"), true);
        }),
      ).pipe(
        Effect.provide(
          CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
        ),
      );
    }).pipe(Effect.scoped);
  });

  it.effect("rejects syntax requests safely after ingress has closed", () => {
    let callbacks = 0;
    const adapter = ShikiAdapter.of({
      create: () => Effect.succeed(highlighter(() => undefined)),
      loadLanguage: () => Effect.void,
    });
    return CodePreviewSyntaxService.use(() => Effect.void).pipe(
      Effect.provide(
        CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
      ),
      Effect.andThen(
        Effect.sync(() => {
          requestSyntaxInitialize("dark-plus", () => callbacks++);
          requestSyntaxLanguage("rust", () => callbacks++);
          requestSyntaxInitialize("dark-plus", () => {
            throw new Error("closed callback failure");
          });
          assert.equal(callbacks, 0);
        }),
      ),
    );
  });

  it.effect("preserves the working highlighter when theme replacement fails", () => {
    setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
    let oldDisposed = 0;
    const old = highlighter(() => oldDisposed++);
    const adapter = ShikiAdapter.of({
      create: (theme) =>
        theme === "old"
          ? Effect.succeed(old)
          : Effect.fail(
              new ShikiBoundaryError({ operation: "initialize", message: "expected failure" }),
            ),
      loadLanguage: () => Effect.void,
    });
    return CodePreviewSyntaxService.use((service) =>
      Effect.gen(function* () {
        yield* service.initialize("old");
        const before = syntaxProjection();
        yield* service.initialize("bad");
        const after = syntaxProjection();
        assert.equal(after?.highlighter, old);
        assert.equal(after?.theme, "old");
        assert.equal(after?.generation, before?.generation);
        assert.equal(oldDisposed, 0);
      }),
    ).pipe(
      Effect.provide(
        CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
      ),
      Effect.ensuring(Effect.sync(() => assert.equal(oldDisposed, 1))),
    );
  });

  it.effect("isolates throwing disposers while transferring replacement ownership", () => {
    setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
    const captured = makeCapturedLogger();
    let oldDisposeAttempts = 0;
    let nextDisposeAttempts = 0;
    const old = highlighter(() => {
      oldDisposeAttempts++;
      throw new Error("third-party disposal failed");
    });
    const next = highlighter(() => nextDisposeAttempts++);
    const adapter = ShikiAdapter.of({
      create: (theme) => Effect.succeed(theme === "old" ? old : next),
      loadLanguage: () => Effect.void,
    });
    const layer = Layer.merge(
      CodePreviewSyntaxService.layer.pipe(Layer.provide(Layer.succeed(ShikiAdapter, adapter))),
      captured.layer,
    );
    return Effect.gen(function* () {
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          yield* service.initialize("old");
          yield* service.initialize("next");
          assert.equal(syntaxProjection()?.highlighter, next);
          assert.equal(syntaxProjection()?.theme, "next");
        }),
      ).pipe(Effect.provide(layer));
      assert.equal(oldDisposeAttempts, 1);
      assert.equal(nextDisposeAttempts, 1);
      assert.match(capturedTelemetrySnapshot(captured), /failed to dispose cleanly/);
    });
  });

  it.effect(
    "interrupts a non-settling language load before disposing and completing shutdown",
    () =>
      Effect.gen(function* () {
        setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: true });
        const started = yield* Deferred.make<void>();
        const events: string[] = [];
        let disposeAttempts = 0;
        const adapter = ShikiAdapter.of({
          create: () =>
            Effect.succeed(
              highlighter(() => {
                disposeAttempts++;
                events.push("dispose");
              }),
            ),
          loadLanguage: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => events.push("language-stopped"))),
            ),
        });
        const session = yield* CodePreviewSyntaxService.use((service) =>
          Effect.gen(function* () {
            yield* service.initialize("dark-plus");
            requestSyntaxLanguage("rust");
            yield* Deferred.await(started);
          }),
        ).pipe(
          Effect.provide(
            CodePreviewSyntaxService.layer.pipe(
              Layer.provide(Layer.succeed(ShikiAdapter, adapter)),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(started);
        yield* Fiber.join(session);
        assert.deepEqual(events, ["language-stopped", "dispose"]);
        assert.equal(disposeAttempts, 1);
      }).pipe(Effect.scoped),
  );

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
