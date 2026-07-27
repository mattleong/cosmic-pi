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

const mapError = (operation: string, path: string, message: string) => () =>
  new SchemaDocumentError({ operation, path, message });

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
