// Scoped cache lifecycle assertions.
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { provideBuiltLayer } from "pi-cosmic-core";
import { lookupBeforeWrite } from "../../src/write/projection";
import { CodePreviewWriteService } from "../../src/write/service";

it.effect("bounds correlation entries and replaces reused call identifiers atomically", () =>
  CodePreviewWriteService.use((service) =>
    Effect.gen(function* () {
      for (let index = 0; index < 65; index++)
        yield* service.rememberBeforeWrite(`tool-${index}`, {
          kind: "content",
          content: String(index),
        });
      assert.equal(lookupBeforeWrite("tool-0"), undefined);
      assert.deepEqual(lookupBeforeWrite("tool-1"), {
        kind: "content",
        content: "1",
      });
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
  ).pipe(provideBuiltLayer(CodePreviewWriteService.layer)),
);

it.effect("before-write snapshots are cleared when the owning session scope closes", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      CodePreviewWriteService.use((service) =>
        Effect.gen(function* () {
          yield* service.rememberBeforeWrite("tool", { kind: "content", content: "secret" });
          assert.deepEqual(lookupBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
          assert.deepEqual(lookupBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
        }),
      ).pipe(provideBuiltLayer(CodePreviewWriteService.layer)),
    );
    assert.equal(lookupBeforeWrite("tool"), undefined);
  }),
);
