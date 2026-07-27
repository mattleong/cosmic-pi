import * as Schema from "effect/Schema";

export class InvalidBackgroundCommandError extends Schema.TaggedErrorClass<InvalidBackgroundCommandError>()(
  "InvalidBackgroundCommandError",
  { message: Schema.String },
) {}

export class InvalidBackgroundCwdError extends Schema.TaggedErrorClass<InvalidBackgroundCwdError>()(
  "InvalidBackgroundCwdError",
  { cwd: Schema.String, message: Schema.String },
) {}

export class BackgroundJobNotFoundError extends Schema.TaggedErrorClass<BackgroundJobNotFoundError>()(
  "BackgroundJobNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export class BackgroundJobCapacityError extends Schema.TaggedErrorClass<BackgroundJobCapacityError>()(
  "BackgroundJobCapacityError",
  { limit: Schema.Number, message: Schema.String },
) {}

export class BackgroundSpawnError extends Schema.TaggedErrorClass<BackgroundSpawnError>()(
  "BackgroundSpawnError",
  { message: Schema.String },
) {}

export class BackgroundRuntimeClosedError extends Schema.TaggedErrorClass<BackgroundRuntimeClosedError>()(
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
