import * as Schema from "effect/Schema";

export class AskUserValidationError extends Schema.TaggedError<
  AskUserValidationError,
  { readonly brand: unique symbol }
>()("AskUserValidationError", { message: Schema.String }) {}

export class AskUserHostError extends Schema.TaggedError<
  AskUserHostError,
  { readonly brand: unique symbol }
>()("AskUserHostError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class AskUserAsyncError extends Schema.TaggedError<
  AskUserAsyncError,
  { readonly brand: unique symbol }
>()("AskUserAsyncError", {
  reason: Schema.Literals(["busy", "not-found", "invalid-control"]),
  message: Schema.String,
}) {}

export class AskUserRuntimeClosedError extends Schema.TaggedError<
  AskUserRuntimeClosedError,
  { readonly brand: unique symbol }
>()("AskUserRuntimeClosedError", { message: Schema.String }) {}
