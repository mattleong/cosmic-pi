import * as Schema from "effect/Schema";

export class JsonDocumentError extends Schema.TaggedError<
  JsonDocumentError,
  { readonly brand: unique symbol }
>()("JsonDocumentError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

export class JsonHttpError extends Schema.TaggedError<
  JsonHttpError,
  { readonly brand: unique symbol }
>()("JsonHttpError", {
  operation: Schema.Literals(["encode", "request", "response", "decode"]),
  message: Schema.String,
}) {}

export class StreamingHttpError extends Schema.TaggedError<
  StreamingHttpError,
  { readonly brand: unique symbol }
>()("StreamingHttpError", {
  operation: Schema.Literals(["encode", "request", "stream"]),
  message: Schema.String,
}) {}
