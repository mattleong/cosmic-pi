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
  operation: Schema.Literals(["request", "response", "decode"]),
  message: Schema.String,
}) {}

export class StreamingHttpError extends Schema.TaggedErrorClass<StreamingHttpError>()(
  "StreamingHttpError",
  {
    operation: Schema.Literals(["encode", "request", "stream"]),
    message: Schema.String,
  },
) {}
