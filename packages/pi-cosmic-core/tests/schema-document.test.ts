import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readSchemaDocument } from "../src/platform/schema-document.ts";
import { provideBuiltLayer } from "../src/runtime/layers.ts";
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
  }).pipe(provideBuiltLayer(memory.layer));
});

it.effect("returns undefined for a missing document", () => {
  const memory = makeInMemoryDocuments();
  return Effect.gen(function* () {
    const current = yield* readSchemaDocument("/config.json", ConfigSchema);
    expect(current).toBeUndefined();
  }).pipe(provideBuiltLayer(memory.layer));
});

it.effect("reports malformed documents with a path but without the rejected value", () => {
  const memory = makeInMemoryDocuments({ "/config.json": { enabled: "secret-value" } });
  return Effect.gen(function* () {
    const result = yield* Effect.result(readSchemaDocument("/config.json", ConfigSchema));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("$.enabled");
      expect(result.failure.message).not.toContain("secret-value");
    }
  }).pipe(provideBuiltLayer(memory.layer));
});

it.effect("bounds diagnostics for wide schema issue trees", () => {
  const alternatives = Array.from({ length: 256 }, (_, index) =>
    Schema.Struct({ kind: Schema.Literal(`kind-${index}`) }),
  );
  const WideConfigSchema = Schema.Union(alternatives);
  const memory = makeInMemoryDocuments({ "/config.json": { kind: "secret-value" } });
  return Effect.gen(function* () {
    const result = yield* Effect.result(readSchemaDocument("/config.json", WideConfigSchema));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message.length).toBeLessThan(512);
      expect(result.failure.message).not.toContain("secret-value");
    }
  }).pipe(provideBuiltLayer(memory.layer));
});

it.effect("redacts dynamic path segments regardless of their length", () => {
  const shortDynamicKey = "sk-short-private-key";
  const longDynamicKey = "private-credential-key-that-is-too-long-for-a-schema-diagnostic";
  const DynamicConfigSchema = Schema.Struct({
    values: Schema.Record(Schema.String, Schema.Boolean),
  });
  const memory = makeInMemoryDocuments({
    "/short.json": { values: { [shortDynamicKey]: "short-secret-value" } },
    "/long.json": { values: { [longDynamicKey]: "long-secret-value" } },
  });
  return Effect.gen(function* () {
    for (const [path, key, value] of [
      ["/short.json", shortDynamicKey, "short-secret-value"],
      ["/long.json", longDynamicKey, "long-secret-value"],
    ] as const) {
      const result = yield* Effect.result(readSchemaDocument(path, DynamicConfigSchema));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("$.values[<redacted>]");
        expect(result.failure.message).not.toContain(key);
        expect(result.failure.message).not.toContain(value);
        expect(result.failure.message.length).toBeLessThan(512);
      }
    }
  }).pipe(provideBuiltLayer(memory.layer));
});
