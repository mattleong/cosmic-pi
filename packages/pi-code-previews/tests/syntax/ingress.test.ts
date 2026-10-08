import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { makeSyntaxIngress } from "../../src/syntax/ingress";
import { clearSyntaxProjection, requestSyntaxLanguage } from "../../src/syntax/projection";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";

it.effect("shares the callback retention bound across duplicate and distinct requests", () =>
  Effect.gen(function* () {
    const owner = acquireProjectionOwnership("code-preview-syntax-projection");
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    let retained = 0;
    let overflow = 0;
    const loaded: string[] = [];
    const ingress = yield* makeSyntaxIngress(owner, {
      initialize: () => Effect.void,
      language: (language) =>
        Effect.gen(function* () {
          loaded.push(language);
          if (language === "rust") {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          } else {
            yield* Deferred.succeed(finished, undefined);
          }
        }),
    });
    yield* Effect.addFinalizer(() =>
      ingress.shutdown.pipe(Effect.andThen(Effect.sync(() => clearSyntaxProjection(owner)))),
    );

    for (let index = 0; index < 128; index++) requestSyntaxLanguage("rust", () => retained++);
    yield* Deferred.await(started);
    requestSyntaxLanguage("go", () => overflow++);
    assert.equal(retained, 0);
    assert.equal(overflow, 1);

    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(finished);
    yield* ingress.shutdown;
    assert.deepEqual(loaded, ["rust", "go"]);
    assert.equal(retained, 128);
    assert.equal(overflow, 1);
  }),
);

it.effect("a saturated row's synchronous redraw does not invalidate it again", () =>
  Effect.gen(function* () {
    const owner = acquireProjectionOwnership("code-preview-syntax-projection");
    const ingress = yield* makeSyntaxIngress(owner, {
      initialize: () => Effect.void,
      language: () => Effect.never,
    });
    yield* Effect.addFinalizer(() =>
      ingress.shutdown.pipe(Effect.andThen(Effect.sync(() => clearSyntaxProjection(owner)))),
    );
    for (let index = 0; index < 128; index++) requestSyntaxLanguage("rust", () => undefined);
    // Pi's invalidate redraws the row at once, and the redraw requests the language again.
    let redraws = 0;
    const invalidate = () => {
      redraws++;
      requestSyntaxLanguage("rust", invalidate);
    };
    requestSyntaxLanguage("rust", invalidate);
    assert.equal(redraws, 1);
  }),
);
