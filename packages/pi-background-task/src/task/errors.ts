import * as Schema from "effect/Schema";

export class InvalidBackgroundCommandError extends Schema.TaggedError<InvalidBackgroundCommandError>()(
  "InvalidBackgroundCommandError",
  { message: Schema.String },
) {}

export class InvalidBackgroundCwdError extends Schema.TaggedError<InvalidBackgroundCwdError>()(
  "InvalidBackgroundCwdError",
  { cwd: Schema.String, message: Schema.String },
) {}

/** An afterCursor beyond a task's output, such as one kept from an earlier task with its ID. */
export const afterCursorAhead = (id: string, afterCursor: number, latest: number) =>
  new InvalidBackgroundCommandError({
    message: `afterCursor is ahead of this task's output\nafterCursor ${afterCursor} is ahead of ${id}'s latest cursor ${latest}; it may come from an earlier task with the same ID. Use ${latest} or less.`,
  });

export class BackgroundTaskNotFoundError extends Schema.TaggedError<BackgroundTaskNotFoundError>()(
  "BackgroundTaskNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export const backgroundTaskNotFound = (id: string) =>
  new BackgroundTaskNotFoundError({
    id,
    message: `Background task not found\nNo task has ID ${id}; it may have been cleared.`,
  });

export class BackgroundTaskCapacityError extends Schema.TaggedError<BackgroundTaskCapacityError>()(
  "BackgroundTaskCapacityError",
  { limit: Schema.Finite, message: Schema.String },
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

export class BackgroundTasksDisabledError extends Schema.TaggedError<BackgroundTasksDisabledError>()(
  "BackgroundTasksDisabledError",
  { message: Schema.String },
) {}

export type BackgroundTaskError =
  | InvalidBackgroundCommandError
  | InvalidBackgroundCwdError
  | BackgroundTaskNotFoundError
  | BackgroundTaskCapacityError
  | BackgroundSpawnError
  | BackgroundTerminationError
  | BackgroundRuntimeClosedError
  | BackgroundTasksDisabledError;
