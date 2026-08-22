import * as Schema from "effect/Schema";

export class JsonDocumentError extends Schema.TaggedError<JsonDocumentError>()(
  "JsonDocumentError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class JsonHttpError extends Schema.TaggedError<JsonHttpError>()("JsonHttpError", {
  operation: Schema.Literals(["encode", "request", "response", "decode"]),
  message: Schema.String,
}) {}

export class StreamingHttpError extends Schema.TaggedError<StreamingHttpError>()(
  "StreamingHttpError",
  {
    operation: Schema.Literals(["encode", "request", "stream"]),
    message: Schema.String,
  },
) {}
