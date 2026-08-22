import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Encodes a schema value and proves that the encoded representation is JSON. */
export const encodeJsonBody = <S extends Schema.Constraint>(
  schema: S,
  body: S["Type"],
): Effect.Effect<Schema.Json, Schema.SchemaError, S["EncodingServices"]> =>
  Schema.encodeEffect(schema)(body).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(Schema.Json)(encoded)),
  );
