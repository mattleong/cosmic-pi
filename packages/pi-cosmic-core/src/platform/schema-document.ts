import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, type JsonObject } from "./json-document.ts";

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

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const mapError = (operation: string, path: string, message: string) => () =>
  new SchemaDocumentError({ operation, path, message });

/** Decode an owned JSON object while retaining its unknown fields for forward-compatible updates. */
export const decodeSchemaDocument = <A>(schema: Schema.Decoder<A>, raw: JsonObject) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.map((value): DecodedDocument<A> => ({ value, raw })),
    Effect.mapError(mapError("decode", "unknown", "Unable to decode schema document.")),
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
  return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.map((value): DecodedDocument<A> => ({ value, raw })),
    Effect.mapError(mapError("decode", path, "Unable to decode schema document.")),
  );
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
  let decodedValue: A | undefined;
  let schemaFailure: SchemaDocumentError | undefined;
  yield* documents
    .updateObject(path, (raw) => {
      const decoded = Schema.decodeUnknownOption(schema)(raw);
      if (decoded._tag === "None") {
        schemaFailure = new SchemaDocumentError({
          operation: "decode",
          path,
          message: "Unable to decode schema document.",
        });
        return raw;
      }
      const value = update({ value: decoded.value, raw });
      const encoded = Schema.encodeUnknownOption(schema)(value);
      if (encoded._tag === "None") {
        schemaFailure = new SchemaDocumentError({
          operation: "encode",
          path,
          message: "Unable to encode schema document.",
        });
        return raw;
      }
      const encodedObject = Schema.decodeUnknownOption(JsonObjectSchema)(encoded.value);
      if (encodedObject._tag === "None") {
        schemaFailure = new SchemaDocumentError({
          operation: "encode",
          path,
          message: "Schema document must encode to an object.",
        });
        return raw;
      }
      decodedValue = value;
      return { ...raw, ...encodedObject.value };
    })
    .pipe(Effect.mapError(mapError("update", path, "Unable to update schema document.")));
  if (schemaFailure) return yield* schemaFailure;
  if (decodedValue !== undefined) return decodedValue;
  return yield* new SchemaDocumentError({
    operation: "update",
    path,
    message: "Schema document update produced no value.",
  });
});
