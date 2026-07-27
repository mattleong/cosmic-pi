// @effect-diagnostics effect/strictEffectProvide:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  JsonDocumentStore,
  type JsonDocumentStoreShape,
  type JsonObject,
} from "../src/platform/json-document.ts";
import { readSchemaDocument, updateSchemaDocument } from "../src/platform/schema-document.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";

const ConfigSchema = Schema.Struct({ enabled: Schema.Boolean });

it.effect("decodes schema documents and preserves unknown fields during updates", () => {
  const memory = makeInMemoryDocuments({
    "/config.json": { enabled: true, future: { value: 1 } },
  });
  return Effect.gen(function* () {
    const current = yield* readSchemaDocument("/config.json", ConfigSchema);
    expect(current?.value.enabled).toBe(true);
    expect(current?.raw.future).toEqual({ value: 1 });
    yield* updateSchemaDocument("/config.json", ConfigSchema, ({ value }) => ({
      ...value,
      enabled: false,
    }));
    expect(memory.documents.get("/config.json")).toEqual({
      enabled: false,
      future: { value: 1 },
    });
  }).pipe(Effect.provide(memory.layer));
});

it.effect("reports malformed documents through the typed channel", () => {
  const memory = makeInMemoryDocuments({ "/config.json": { enabled: "yes" } });
  return Effect.gen(function* () {
    const result = yield* Effect.result(readSchemaDocument("/config.json", ConfigSchema));
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(memory.layer));
});

it.effect("fails closed before I/O when a legacy store lacks atomic modification", () => {
  let reads = 0;
  let writes = 0;
  let updates = 0;
  const legacyService: JsonDocumentStoreShape = {
    exists: () => Effect.succeed(true),
    readObject: () =>
      Effect.sync(() => {
        reads++;
        return { enabled: true };
      }),
    writeObject: () => Effect.sync(() => void writes++),
    updateObject: (_path, update) =>
      Effect.sync(() => {
        updates++;
        return update({ enabled: true });
      }),
  };
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      updateSchemaDocument("/config.json", ConfigSchema, () => ({ enabled: false })),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("update");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(updates).toBe(0);
  }).pipe(Effect.provideService(JsonDocumentStore, JsonDocumentStore.of(legacyService)));
});

it.effect("removes omitted schema-owned fields while preserving unknown fields", () => {
  const OptionalConfigSchema = Schema.Struct({ enabled: Schema.optional(Schema.Boolean) });
  const memory = makeInMemoryDocuments({
    "/config.json": { enabled: true, future: { value: 1 } },
  });
  return Effect.gen(function* () {
    const value = yield* updateSchemaDocument("/config.json", OptionalConfigSchema, () => ({}));
    expect(value).toEqual({});
    expect(memory.documents.get("/config.json")).toEqual({ future: { value: 1 } });
  }).pipe(Effect.provide(memory.layer));
});

it.effect("preserves an own JSON __proto__ field without changing the document prototype", () => {
  const initial: JsonObject = { enabled: true };
  Object.defineProperty(initial, "__proto__", {
    value: { future: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const memory = makeInMemoryDocuments({ "/config.json": initial });
  return Effect.gen(function* () {
    yield* updateSchemaDocument("/config.json", ConfigSchema, () => ({ enabled: false }));
    const persisted = memory.documents.get("/config.json");
    expect(persisted).toBeDefined();
    expect(Object.hasOwn(persisted!, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(persisted!, "__proto__")?.value).toEqual({
      future: true,
    });
    expect(Object.getPrototypeOf(persisted!)).toBe(Object.prototype);
  }).pipe(Effect.provide(memory.layer));
});

it.effect("supports a valid undefined decoded value without a sentinel collision", () => {
  const UndefinedDocumentSchema = Schema.Struct({ marker: Schema.optional(Schema.String) }).pipe(
    Schema.decodeTo(Schema.Undefined, {
      decode: SchemaGetter.transform(() => undefined),
      encode: SchemaGetter.transform(() => ({ marker: "saved" })),
    }),
  );
  const memory = makeInMemoryDocuments({ "/config.json": { future: true } });
  return Effect.gen(function* () {
    const value = yield* updateSchemaDocument(
      "/config.json",
      UndefinedDocumentSchema,
      () => undefined,
    );
    expect(value).toBeUndefined();
    expect(memory.documents.get("/config.json")).toEqual({ future: true, marker: "saved" });
  }).pipe(Effect.provide(memory.layer));
});

it.effect("does not commit when decoding or encoding fails", () => {
  const FiniteConfigSchema = Schema.Struct({
    value: Schema.Number.check(Schema.isFinite()),
  });
  const malformed = makeInMemoryDocuments({ "/config.json": { value: "bad", future: true } });
  const finite = makeInMemoryDocuments({ "/config.json": { value: 1, future: true } });
  let malformedWrites = 0;
  let finiteWrites = 0;
  const malformedService = JsonDocumentStore.of({
    ...malformed.service,
    modifyObject: (path, modify) =>
      malformed.service
        .modifyObject(path, modify)
        .pipe(Effect.tap(() => Effect.sync(() => void malformedWrites++))),
  });
  const finiteService = JsonDocumentStore.of({
    ...finite.service,
    modifyObject: (path, modify) =>
      finite.service
        .modifyObject(path, modify)
        .pipe(Effect.tap(() => Effect.sync(() => void finiteWrites++))),
  });
  return Effect.gen(function* () {
    const decodeResult = yield* Effect.result(
      updateSchemaDocument("/config.json", FiniteConfigSchema, ({ value }) => value).pipe(
        Effect.provideService(JsonDocumentStore, malformedService),
      ),
    );
    const encodeResult = yield* Effect.result(
      updateSchemaDocument("/config.json", FiniteConfigSchema, () => ({ value: Number.NaN })).pipe(
        Effect.provideService(JsonDocumentStore, finiteService),
      ),
    );
    expect(decodeResult._tag).toBe("Failure");
    if (decodeResult._tag === "Failure") expect(decodeResult.failure.operation).toBe("decode");
    expect(encodeResult._tag).toBe("Failure");
    if (encodeResult._tag === "Failure") expect(encodeResult.failure.operation).toBe("encode");
    expect(malformedWrites).toBe(0);
    expect(finiteWrites).toBe(0);
    expect(malformed.documents.get("/config.json")).toEqual({ value: "bad", future: true });
    expect(finite.documents.get("/config.json")).toEqual({ value: 1, future: true });
  });
});
