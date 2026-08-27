import * as Schema from "effect/Schema";

export class InvalidBackgroundCommandError extends Schema.TaggedError<InvalidBackgroundCommandError>()(
  "InvalidBackgroundCommandError",
  { message: Schema.String },
) {}

export class InvalidBackgroundCwdError extends Schema.TaggedError<InvalidBackgroundCwdError>()(
  "InvalidBackgroundCwdError",
  { cwd: Schema.String, message: Schema.String },
) {}

export class BackgroundTaskNotFoundError extends Schema.TaggedError<BackgroundTaskNotFoundError>()(
  "BackgroundTaskNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export class BackgroundTaskCapacityError extends Schema.TaggedError<BackgroundTaskCapacityError>()(
  "BackgroundTaskCapacityError",
  { limit: Schema.Number, message: Schema.String },
) {}

export class BackgroundSpawnError extends Schema.TaggedError<BackgroundSpawnError>()(
  "BackgroundSpawnError",
  { message: Schema.String },
) {}

export class BackgroundTerminationError extends Schema.TaggedError<BackgroundTerminationError>()(
  "BackgroundTerminationError",
  { id: Schema.String, message: Schema.String },
) {}

export class BackgroundRuntimeClosedError extends Schema.TaggedError<BackgroundRuntimeClosedError>()(
  "BackgroundRuntimeClosedError",
  { message: Schema.String },
) {}

export type BackgroundTaskError =
  | InvalidBackgroundCommandError
  | InvalidBackgroundCwdError
  | BackgroundTaskNotFoundError
  | BackgroundTaskCapacityError
  | BackgroundSpawnError
  | BackgroundTerminationError
  | BackgroundRuntimeClosedError;
