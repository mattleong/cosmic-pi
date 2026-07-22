// Scoped cache lifecycle assertions.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { lookupBeforeWrite, writeProjectionSize } from "../../src/write/projection";
import { CodePreviewWriteService } from "../../src/write/service";

it.effect("bounds correlation entries and replaces reused call identifiers atomically", () =>
  CodePreviewWriteService.use((service) =>
    Effect.gen(function* () {
      for (let index = 0; index < 65; index++)
        yield* service.rememberBeforeWrite(`tool-${index}`, {
          kind: "content",
          content: String(index),
        });
      assert.equal(writeProjectionSize(), 64);
      assert.equal(lookupBeforeWrite("tool-0"), undefined);
      yield* service.rememberBeforeWrite("tool-64", {
        kind: "content",
        content: "replacement",
      });
      assert.deepEqual(lookupBeforeWrite("tool-64"), {
        kind: "content",
        content: "replacement",
      });
      assert.equal(Object.isFrozen(lookupBeforeWrite("tool-64")), true);
    }),
  ).pipe(Effect.provide(CodePreviewWriteService.layer)),
);

it.effect("before-write snapshots are cleared when the owning session scope closes", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      CodePreviewWriteService.use((service) =>
        Effect.gen(function* () {
          yield* service.rememberBeforeWrite("tool", { kind: "content", content: "secret" });
          assert.equal(writeProjectionSize(), 1);
          assert.deepEqual(lookupBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
          assert.deepEqual(lookupBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
          assert.equal(yield* service.cacheSize, 1);
          assert.deepEqual(yield* service.acknowledgeBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
          assert.equal(writeProjectionSize(), 0);
        }),
      ).pipe(Effect.provide(CodePreviewWriteService.layer)),
    );
    assert.equal(writeProjectionSize(), 0);
  }),
);
