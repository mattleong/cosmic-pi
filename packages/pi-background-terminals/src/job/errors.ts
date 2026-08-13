import * as Schema from "effect/Schema";

export class InvalidBackgroundCommandError extends Schema.TaggedError<InvalidBackgroundCommandError>()(
  "InvalidBackgroundCommandError",
  { message: Schema.String },
) {}

export class InvalidBackgroundCwdError extends Schema.TaggedError<InvalidBackgroundCwdError>()(
  "InvalidBackgroundCwdError",
  { cwd: Schema.String, message: Schema.String },
) {}

export class BackgroundJobNotFoundError extends Schema.TaggedError<BackgroundJobNotFoundError>()(
  "BackgroundJobNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export class BackgroundJobCapacityError extends Schema.TaggedError<BackgroundJobCapacityError>()(
  "BackgroundJobCapacityError",
  { limit: Schema.Number, message: Schema.String },
) {}

export class BackgroundSpawnError extends Schema.TaggedError<BackgroundSpawnError>()(
  "BackgroundSpawnError",
  { message: Schema.String },
) {}

export class BackgroundRuntimeClosedError extends Schema.TaggedError<BackgroundRuntimeClosedError>()(
  "BackgroundRuntimeClosedError",
  { message: Schema.String },
) {}

export type BackgroundTerminalError =
  | InvalidBackgroundCommandError
  | InvalidBackgroundCwdError
  | BackgroundJobNotFoundError
  | BackgroundJobCapacityError
  | BackgroundSpawnError
  | BackgroundRuntimeClosedError;
