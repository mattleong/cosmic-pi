import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { acquireSyntaxIngress } from "../../src/syntax/ingress";
import { clearSyntaxProjection, requestSyntaxLanguage } from "../../src/syntax/projection";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";

it.effect("a saturated row's synchronous redraw does not invalidate it again", () =>
  Effect.gen(function* () {
    const owner = acquireProjectionOwnership("code-preview-syntax-projection");
    const ingress = yield* acquireSyntaxIngress(owner, {
      initialize: () => Effect.void,
      language: () => Effect.never,
    });
    yield* Effect.addFinalizer(() =>
      ingress.shutdown.pipe(Effect.andThen(Effect.sync(() => clearSyntaxProjection(owner)))),
    );
    for (let index = 0; index < 128; index++) requestSyntaxLanguage("rust", () => undefined);
    let redraws = 0;
    const invalidate = () => {
      redraws++;
      requestSyntaxLanguage("rust", invalidate);
    };
    requestSyntaxLanguage("rust", invalidate);
    assert.equal(redraws, 1);
  }),
);
