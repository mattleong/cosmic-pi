// @effect-diagnostics effect/strictEffectProvide:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readSchemaDocument } from "../src/platform/schema-document.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";

const ConfigSchema = Schema.Struct({ enabled: Schema.Boolean });

it.effect("decodes schema documents and exposes unknown fields on the raw document", () => {
  const memory = makeInMemoryDocuments({
    "/config.json": { enabled: true, future: { value: 1 } },
  });
  return Effect.gen(function* () {
    const current = yield* readSchemaDocument("/config.json", ConfigSchema);
    expect(current?.value.enabled).toBe(true);
    expect(current?.raw.future).toEqual({ value: 1 });
  }).pipe(Effect.provide(memory.layer));
});

it.effect("returns undefined for a missing document", () => {
  const memory = makeInMemoryDocuments();
  return Effect.gen(function* () {
    const current = yield* readSchemaDocument("/config.json", ConfigSchema);
    expect(current).toBeUndefined();
  }).pipe(Effect.provide(memory.layer));
});

it.effect("reports malformed documents through the typed channel", () => {
  const memory = makeInMemoryDocuments({ "/config.json": { enabled: "yes" } });
  return Effect.gen(function* () {
    const result = yield* Effect.result(readSchemaDocument("/config.json", ConfigSchema));
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(memory.layer));
});
