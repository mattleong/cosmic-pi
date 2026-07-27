import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "./json-document.ts";

export class SchemaDocumentError extends Schema.TaggedErrorClass<SchemaDocumentError>()(
  "SchemaDocumentError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export interface DecodedDocument<A> {
  readonly value: A;
  readonly raw: JsonObject;
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const mapError = (operation: string, path: string, message: string) => () =>
  new SchemaDocumentError({ operation, path, message });

const encodeSchemaObject = <A>(path: string, schema: Schema.Codec<A, unknown>, value: A) =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(JsonObjectSchema)(encoded)),
    Effect.mapError(mapError("encode", path, "Schema document must encode to a JSON object.")),
  );

const defineOwnJsonProperties = (target: JsonObject, source: JsonObject): void => {
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      value: source[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
};

const decodeSchemaObject = <A>(path: string, schema: Schema.Decoder<A>, raw: JsonObject) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.map((value): DecodedDocument<A> => ({ value, raw })),
    Effect.mapError(mapError("decode", path, "Unable to decode schema document.")),
  );

export const readSchemaDocument = Effect.fn("SchemaDocument.read")(function* <A>(
  path: string,
  schema: Schema.Decoder<A>,
) {
  const documents = yield* JsonDocumentStore;
  const raw = yield* documents
    .readObject(path)
    .pipe(Effect.mapError(mapError("read", path, "Unable to read schema document.")));
  if (raw === undefined) return undefined;
  return yield* decodeSchemaObject(path, schema, raw);
});

/**
 * Atomically updates a schema-owned document. Encoded fields replace fields owned by the schema,
 * while unknown top-level fields from the latest document are retained.
 */
export const updateSchemaDocument = Effect.fn("SchemaDocument.update")(function* <A>(
  path: string,
  schema: Schema.Codec<A, unknown>,
  update: (document: DecodedDocument<A>) => A,
) {
  const documents = yield* JsonDocumentStore;
  const modifyObject = documents.modifyObject;
  if (modifyObject === undefined) {
    return yield* new SchemaDocumentError({
      operation: "update",
      path,
      message: "Atomic JSON document updates are unavailable.",
    });
  }
  return yield* modifyObject(path, (raw) =>
    Effect.gen(function* () {
      const current = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(mapError("decode", path, "Unable to decode schema document.")),
      );
      const currentEncoded = yield* encodeSchemaObject(path, schema, current);
      const value = yield* Effect.try({
        try: () => update({ value: current, raw }),
        catch: mapError("update", path, "Unable to update schema document."),
      });
      const encoded = yield* encodeSchemaObject(path, schema, value);
      const document: JsonObject = {};
      defineOwnJsonProperties(document, raw);
      for (const key of Object.keys(currentEncoded)) delete document[key];
      defineOwnJsonProperties(document, encoded);
      return { value, document } satisfies JsonDocumentModification<A>;
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof SchemaDocumentError
        ? error
        : new SchemaDocumentError({
            operation: "update",
            path,
            message: "Unable to update schema document.",
          }),
    ),
  );
});
