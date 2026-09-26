// Resource lifecycle assertions.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  makeCapturedTracer,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import {
  ShikiAdapter,
  ShikiBoundaryError,
  type ShikiAdapterContract,
  type ShikiHighlighter,
} from "../../src/boundary/shiki";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import {
  requestSyntaxInitialize,
  requestSyntaxLanguage,
  syntaxProjection,
} from "../../src/syntax/projection";
import { CodePreviewSyntaxService } from "../../src/syntax/service";
import { getShikiStatus, renderWithShiki } from "../../src/syntax/render";

/** A token whose color may be a probe that counts ANSI color conversions. */
type TokenFixture = {
  readonly content: string;
  readonly color: string | { readonly replace: () => string };
  readonly offset?: number;
};

const highlighter = (
  dispose: () => void = () => undefined,
  codeToTokensBase: (code: string) => TokenFixture[][] = (code) => [
    [{ content: code, color: "#ffffff" }],
  ],
) => opaqueFixture({ dispose, codeToTokensBase });

const syntaxLayer = (
  create: ShikiAdapterContract["create"],
  loadLanguage: ShikiAdapterContract["loadLanguage"] = () => Effect.void,
) =>
  CodePreviewSyntaxService.layer.pipe(
    Layer.provide(Layer.succeed(ShikiAdapter, ShikiAdapter.of({ create, loadLanguage }))),
  );

const makeAnsiColorProbe = () => {
  let conversions = 0;
  const color = {
    replace: () => {
      conversions++;
      return "#ffffff";
    },
  };
  return { color, conversions: () => conversions };
};

describe("session syntax service", () => {
  beforeEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

  it.effect("shares initialization and captures a redacted resource span", () => {
    const captured = makeCapturedTracer();
    let created = 0;
    let disposed = 0;
    const layer = syntaxLayer(() =>
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            created++;
            return highlighter(() => disposed++);
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* CodePreviewSyntaxService;
      yield* Effect.all(
        [service.initialize("secret-theme-path"), service.initialize("secret-theme-path")],
        {
          concurrency: "unbounded",
        },
      );
      assert.equal(created, 1);
      assert.equal(getShikiStatus().initialized, true);
      assert.ok(captured.spans.some((span) => span.name === "pi-code-previews.shiki.initialize"));
      assert.equal(capturedTelemetrySnapshot(captured).includes("secret-theme-path"), false);
    }).pipe(
      provideBuiltLayer(Layer.merge(layer, captured.layer)),
      Effect.ensuring(Effect.sync(() => assert.equal(disposed, 1))),
    );
  });

  it.effect("rejects late initialization replacement and invokes language callbacks once", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<ShikiHighlighter>();
      let firstDisposed = 0;
      let secondDisposed = 0;
      let languageLoads = 0;
      const layer = syntaxLayer(
        (theme) =>
          theme === "first"
            ? Deferred.await(first)
            : Effect.succeed(highlighter(() => secondDisposed++)),
        () => Effect.sync(() => languageLoads++),
      );
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
      ).pipe(provideBuiltLayer(layer));
      assert.equal(secondDisposed, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "returning to the loaded theme revokes a pending replacement without clearing its cache",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const candidate = yield* Deferred.make<ShikiHighlighter>();
        let creates = 0;
        let renders = 0;
        const current = highlighter(undefined, (code) => {
          renders++;
          return [[{ content: code, color: "#ffffff", offset: 0 }]];
        });
        const layer = syntaxLayer((theme) => {
          creates++;
          return theme === "dark-plus"
            ? Effect.succeed(current)
            : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(candidate)));
        });
        yield* CodePreviewSyntaxService.use((service) =>
          Effect.gen(function* () {
            yield* service.initialize("dark-plus");
            assert.ok(renderWithShiki("source", "typescript"));
            const replacement = yield* service.initialize("other").pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            let waiterSettled = false;
            const waiter = yield* service.initialize("other").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  waiterSettled = true;
                }),
              ),
              Effect.forkScoped,
            );
            yield* Effect.yieldNow;
            yield* service.initialize("dark-plus");
            for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
            assert.equal(waiterSettled, true);
            assert.equal(yield* Deferred.isDone(candidate), false);
            yield* Fiber.interrupt(replacement);
            yield* Fiber.join(waiter);
            for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
            assert.equal(creates, 2);
            assert.equal(syntaxProjection()?.highlighter, current);
            assert.equal(syntaxProjection()?.theme, "dark-plus");
            assert.ok(renderWithShiki("source", "typescript"));
            assert.equal(renders, 1);
          }),
        ).pipe(provideBuiltLayer(layer));
      }).pipe(Effect.scoped),
  );

  it.effect("a newer theme settles obsolete joiners before their owner finishes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const candidate = yield* Deferred.make<ShikiHighlighter>();
      const joined = yield* Deferred.make<void>();
      const current = highlighter();
      const creates: string[] = [];
      const layer = syntaxLayer((theme) => {
        creates.push(theme);
        return theme === "older"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(candidate)))
          : Effect.succeed(current);
      });
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          const owner = yield* service.initialize("older").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const waiter = yield* service
            .initialize("older")
            .pipe(Effect.andThen(Deferred.succeed(joined, undefined)), Effect.forkScoped);
          yield* Effect.yieldNow;
          assert.equal(yield* Deferred.isDone(joined), false);
          yield* service.initialize("newer");
          for (let step = 0; step < 20; step++) yield* Effect.yieldNow;
          assert.equal(yield* Deferred.isDone(joined), true);
          assert.equal(yield* Deferred.isDone(candidate), false);
          yield* Fiber.interrupt(owner);
          yield* Fiber.join(waiter);
          assert.deepEqual(creates, ["older", "newer"]);
          assert.equal(syntaxProjection()?.theme, "newer");
          assert.equal(syntaxProjection()?.highlighter, current);
        }),
      ).pipe(provideBuiltLayer(layer));
    }).pipe(Effect.scoped),
  );

  it.effect("disposes a late candidate after returning to the already loaded theme", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const candidate = yield* Deferred.make<ShikiHighlighter>();
      const current = highlighter();
      let disposed = 0;
      const layer = syntaxLayer((theme) =>
        theme === "dark-plus"
          ? Effect.succeed(current)
          : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(candidate))),
      );
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          yield* service.initialize("dark-plus");
          const replacement = yield* service.initialize("other").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* service.initialize("dark-plus");
          yield* Deferred.succeed(
            candidate,
            highlighter(() => disposed++),
          );
          yield* Fiber.join(replacement);
          assert.equal(disposed, 1);
          assert.equal(syntaxProjection()?.highlighter, current);
          assert.equal(syntaxProjection()?.theme, "dark-plus");
        }),
      ).pipe(provideBuiltLayer(layer));
      assert.equal(disposed, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupting a duplicate initializer leaves the blocked owner running", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const candidate = yield* Deferred.make<ShikiHighlighter>();
      let creates = 0;
      let ownerCancelled = false;
      const layer = syntaxLayer(() =>
        Effect.gen(function* () {
          creates++;
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(candidate);
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              ownerCancelled = true;
            }),
          ),
        ),
      );
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          const owner = yield* service.initialize("dark-plus").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const waiter = yield* service.initialize("dark-plus").pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          let cancelled = false;
          const cancellation = yield* Fiber.interrupt(waiter).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
            Effect.forkScoped,
          );
          const installed = highlighter();
          yield* Effect.gen(function* () {
            for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
            assert.equal(cancelled, true);
            assert.equal(ownerCancelled, false);
            assert.equal(creates, 1);
            assert.equal(yield* Deferred.isDone(candidate), false);
          }).pipe(Effect.ensuring(Deferred.succeed(candidate, installed)));
          yield* Fiber.join(cancellation);
          yield* Fiber.join(owner);
          assert.equal(syntaxProjection()?.highlighter, installed);
          assert.equal(ownerCancelled, false);
          assert.equal(creates, 1);
        }),
      ).pipe(provideBuiltLayer(layer));
    }).pipe(Effect.scoped),
  );

  it.effect("logs only a redacted actionable Shiki degradation", () => {
    const captured = makeCapturedLogger();
    const layer = syntaxLayer(() =>
      Effect.fail(
        new ShikiBoundaryError({
          operation: "initialize",
          message: "secret-theme /secret/path sk-secret",
        }),
      ),
    );
    return CodePreviewSyntaxService.use((service) =>
      service
        .initialize("secret-theme")
        .pipe(Effect.andThen(Effect.sync(() => assert.equal(getShikiStatus().initialized, false)))),
    ).pipe(
      provideBuiltLayer(Layer.merge(layer, captured.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          const telemetry = capturedTelemetrySnapshot(captured);
          assert.match(telemetry, /Shiki failed to initialize/);
          assert.equal(telemetry.includes("secret-theme"), false);
          assert.equal(telemetry.includes("secret/path"), false);
          assert.equal(telemetry.includes("sk-secret"), false);
        }),
      ),
    );
  });

  it.effect("interrupted initialization clears its flight and permits retry", () => {
    let interrupted = 0;
    let creates = 0;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const layer = syntaxLayer(() => {
        creates++;
        return creates === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => interrupted++)),
            )
          : Effect.succeed(highlighter());
      });
      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          const first = yield* service.initialize("dark-plus").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(first);
          yield* service.initialize("dark-plus");
          assert.equal(creates, 2);
          assert.equal(interrupted, 1);
          assert.equal(getShikiStatus().initialized, true);
        }),
      ).pipe(provideBuiltLayer(layer));
    }).pipe(Effect.scoped);
  });

  it.effect("cancellation at initialization admission never strands a later caller", () =>
    Effect.gen(function* () {
      for (let boundary = 0; boundary < 100; boundary++) {
        yield* CodePreviewSyntaxService.use((service) =>
          Effect.gen(function* () {
            const owner = yield* service
              .initialize("dark-plus")
              .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16), Effect.forkScoped);
            for (let step = 0; step < boundary; step++) yield* Effect.yieldNow;
            yield* Fiber.interrupt(owner);
            const completed = yield* Deferred.make<void>();
            yield* service
              .initialize("dark-plus")
              .pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.forkScoped);
            for (let step = 0; step < 10; step++) yield* Effect.yieldNow;
            assert.equal(
              yield* Deferred.isDone(completed),
              true,
              `stranded at admission boundary ${boundary}`,
            );
          }),
        ).pipe(provideBuiltLayer(syntaxLayer(() => Effect.succeed(highlighter()))));
      }
    }).pipe(Effect.scoped),
  );

  it.effect("bounds duplicate initialization ingress without losing invalidations", () => {
    const requests = 200;
    let callbacks = 0;
    let creates = 0;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const layer = syntaxLayer(() => {
        creates++;
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(highlighter()),
        );
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
      ).pipe(provideBuiltLayer(layer));
    }).pipe(Effect.scoped);
  });

  it.effect("bounds duplicate language ingress and isolates invalidation failures", () => {
    const requests = 200;
    let callbacks = 0;
    let languageLoads = 0;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const layer = syntaxLayer(
        () => Effect.succeed(highlighter()),
        () => {
          languageLoads++;
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));
        },
      );
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
      ).pipe(provideBuiltLayer(layer));
    }).pipe(Effect.scoped);
  });

  it.effect("rejects syntax requests safely after ingress has closed", () => {
    let callbacks = 0;
    return CodePreviewSyntaxService.use(() => Effect.void).pipe(
      provideBuiltLayer(syntaxLayer(() => Effect.succeed(highlighter()))),
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
    let oldDisposed = 0;
    const old = highlighter(() => oldDisposed++);
    const layer = syntaxLayer((theme) =>
      theme === "old"
        ? Effect.succeed(old)
        : Effect.fail(
            new ShikiBoundaryError({ operation: "initialize", message: "expected failure" }),
          ),
    );
    return CodePreviewSyntaxService.use((service) =>
      Effect.gen(function* () {
        yield* service.initialize("old");
        yield* service.initialize("bad");
        const after = syntaxProjection();
        assert.equal(after?.highlighter, old);
        assert.equal(after?.theme, "old");
        assert.equal(oldDisposed, 0);
      }),
    ).pipe(
      provideBuiltLayer(layer),
      Effect.ensuring(Effect.sync(() => assert.equal(oldDisposed, 1))),
    );
  });

  it.effect("isolates throwing disposers while transferring replacement ownership", () => {
    const captured = makeCapturedLogger();
    let oldDisposeAttempts = 0;
    let nextDisposeAttempts = 0;
    const old = highlighter(() => {
      oldDisposeAttempts++;
      throw new Error("third-party disposal failed");
    });
    const next = highlighter(() => nextDisposeAttempts++);
    const layer = Layer.merge(
      syntaxLayer((theme) => Effect.succeed(theme === "old" ? old : next)),
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
      ).pipe(provideBuiltLayer(layer));
      assert.equal(oldDisposeAttempts, 1);
      assert.equal(nextDisposeAttempts, 1);
      assert.match(capturedTelemetrySnapshot(captured), /failed to dispose cleanly/);
    });
  });

  it.effect(
    "interrupts a non-settling language load before disposing and completing shutdown",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const events: string[] = [];
        let disposeAttempts = 0;
        const layer = syntaxLayer(
          () =>
            Effect.succeed(
              highlighter(() => {
                disposeAttempts++;
                events.push("dispose");
              }),
            ),
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => events.push("language-stopped"))),
            ),
        );
        const session = yield* CodePreviewSyntaxService.use((service) =>
          Effect.gen(function* () {
            yield* service.initialize("dark-plus");
            requestSyntaxLanguage("rust");
            yield* Deferred.await(started);
          }),
        ).pipe(provideBuiltLayer(layer), Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.join(session);
        assert.deepEqual(events, ["language-stopped", "dispose"]);
        assert.equal(disposeAttempts, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("session finalization discards caches owned by its highlighter", () => {
    let renders = 0;
    const color = makeAnsiColorProbe();
    const reused = highlighter(undefined, (code) => {
      renders++;
      return [[{ content: `${renders}:${code}`, color: color.color }]];
    });
    const renderSession = CodePreviewSyntaxService.use((service) =>
      service
        .initialize("dark-plus")
        .pipe(Effect.andThen(Effect.sync(() => renderWithShiki("same source", "typescript")))),
    ).pipe(provideBuiltLayer(syntaxLayer(() => Effect.succeed(reused))));

    return Effect.gen(function* () {
      yield* renderSession;
      yield* renderSession;
      assert.equal(renders, 2);
      assert.equal(color.conversions(), 2);
    });
  });

  it.effect("replacement discards color conversions owned by the previous highlighter", () => {
    const color = makeAnsiColorProbe();
    const previous = highlighter(undefined, (code) => [
      [{ content: `previous:${code}`, color: color.color }],
    ]);
    const next = highlighter(undefined, (code) => [
      [{ content: `next:${code}`, color: color.color }],
    ]);
    const layer = syntaxLayer((theme) => Effect.succeed(theme === "old" ? previous : next));

    return CodePreviewSyntaxService.use((service) =>
      Effect.gen(function* () {
        setCodePreviewSettings({ ...codePreviewSettings, shikiTheme: "old" });
        yield* service.initialize("old");
        assert.ok(renderWithShiki("same source", "typescript"));
        setCodePreviewSettings({ ...codePreviewSettings, shikiTheme: "next" });
        yield* service.initialize("next");
        assert.ok(renderWithShiki("same source", "typescript"));
        assert.equal(color.conversions(), 2);
      }),
    ).pipe(provideBuiltLayer(layer));
  });

  it.effect("stale highlighter cleanup preserves a newer highlighter's caches", () =>
    Effect.gen(function* () {
      const staleCandidate = yield* Deferred.make<ShikiHighlighter>();
      let currentRenders = 0;
      const color = makeAnsiColorProbe();
      const current = highlighter(undefined, (code) => {
        currentRenders++;
        return [[{ content: `current:${code}`, color: color.color }]];
      });
      const layer = syntaxLayer((theme) =>
        theme === "github-dark" ? Deferred.await(staleCandidate) : Effect.succeed(current),
      );

      yield* CodePreviewSyntaxService.use((service) =>
        Effect.gen(function* () {
          const stale = yield* service.initialize("github-dark").pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* service.initialize("dark-plus");
          assert.ok(renderWithShiki("same source", "typescript"));
          yield* Deferred.succeed(staleCandidate, highlighter());
          yield* Fiber.join(stale);
          assert.ok(renderWithShiki("same source", "typescript"));
          assert.ok(renderWithShiki("different source", "typescript"));
          assert.equal(currentRenders, 2);
          assert.equal(color.conversions(), 1);
        }),
      ).pipe(provideBuiltLayer(layer));
    }).pipe(Effect.scoped),
  );
});
