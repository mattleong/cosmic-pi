// Scoped cache lifecycle assertions.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodePreviewWriteService, writeServiceProjection } from "./service";

it.effect("before-write snapshots are cleared when the owning session scope closes", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      CodePreviewWriteService.use((service) =>
        Effect.sync(() => {
          service.rememberBeforeWrite("tool", { kind: "content", content: "secret" });
          assert.equal(writeServiceProjection()?.cacheSize(), 1);
        }),
      ).pipe(Effect.provide(CodePreviewWriteService.layer)),
    );
    assert.equal(writeServiceProjection(), undefined);
  }),
);
