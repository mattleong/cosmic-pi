import * as Schema from "effect/Schema";

export class JsonDocumentError extends Schema.TaggedErrorClass<JsonDocumentError>()(
  "JsonDocumentError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class JsonHttpError extends Schema.TaggedErrorClass<JsonHttpError>()("JsonHttpError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
