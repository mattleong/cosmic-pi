import * as Schema from "effect/Schema";

export class AskUserValidationError extends Schema.TaggedError<AskUserValidationError>()(
  "AskUserValidationError",
  { message: Schema.String },
) {}

export class AskUserHostError extends Schema.TaggedError<AskUserHostError>()("AskUserHostError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class AskUserAsyncError extends Schema.TaggedError<AskUserAsyncError>()(
  "AskUserAsyncError",
  {
    reason: Schema.Literals(["busy", "unavailable", "not-found", "invalid-control"]),
    message: Schema.String,
  },
) {}

export class AskUserRuntimeClosedError extends Schema.TaggedError<AskUserRuntimeClosedError>()(
  "AskUserRuntimeClosedError",
  { message: Schema.String },
) {}
