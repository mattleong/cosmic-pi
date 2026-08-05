import * as Schema from "effect/Schema";

export class AskUserValidationError extends Schema.TaggedErrorClass<AskUserValidationError>()(
  "AskUserValidationError",
  { message: Schema.String },
) {}

export class AskUserHostError extends Schema.TaggedErrorClass<AskUserHostError>()(
  "AskUserHostError",
  { operation: Schema.String, message: Schema.String },
) {}

export class AskUserRuntimeClosedError extends Schema.TaggedErrorClass<AskUserRuntimeClosedError>()(
  "AskUserRuntimeClosedError",
  { message: Schema.String },
) {}

export type AskUserError = AskUserValidationError | AskUserHostError | AskUserRuntimeClosedError;
