import * as Predicate from "effect/Predicate";

import * as Schema from "effect/Schema";

export class InvalidSubagentRequestError extends Schema.TaggedError<InvalidSubagentRequestError>()(
  "InvalidSubagentRequestError",
  { message: Schema.String, code: Schema.optional(Schema.String) },
) {}

export class SubagentNotFoundError extends Schema.TaggedError<SubagentNotFoundError>()(
  "SubagentNotFoundError",
  { id: Schema.String, message: Schema.String },
) {}

export class SubagentCapacityError extends Schema.TaggedError<SubagentCapacityError>()(
  "SubagentCapacityError",
  { limit: Schema.Number, message: Schema.String },
) {}

export class SubagentHistoryCapacityError extends Schema.TaggedError<SubagentHistoryCapacityError>()(
  "SubagentHistoryCapacityError",
  { limit: Schema.Number, code: Schema.String, message: Schema.String },
) {}

export class SubagentWriterConflictError extends Schema.TaggedError<SubagentWriterConflictError>()(
  "SubagentWriterConflictError",
  { activeId: Schema.String, activeName: Schema.String, message: Schema.String },
) {}

export class UnsupportedSafeWriterOwnershipError extends Schema.TaggedError<UnsupportedSafeWriterOwnershipError>()(
  "UnsupportedSafeWriterOwnershipError",
  {
    code: Schema.Literal("unsupported_safe_writer_ownership"),
    platform: Schema.String,
    message: Schema.String,
  },
) {}

export class SubagentProcessError extends Schema.TaggedError<SubagentProcessError>()(
  "SubagentProcessError",
  { operation: Schema.String, message: Schema.String, code: Schema.optional(Schema.String) },
) {}

/** Machine-actionable failure code: an explicit `code` when present, else the error tag. */
export const subagentErrorCode = (error: SubagentError): string =>
  ("code" in error && Predicate.isString(error.code) && error.code !== "" && error.code) ||
  error._tag;

/**
 * By convention, `code` values ending in `_outcome_uncertain` mark failures whose side effects may
 * already have applied; callers must not retry or fall through to another candidate.
 */
export const isOutcomeUncertain = (error: { readonly code?: string | undefined }): boolean =>
  error.code?.endsWith("_outcome_uncertain") === true;

/**
 * By convention, `code` values ending in `_cleanup_unconfirmed` mark failures that left private
 * state possibly present; callers must fail closed instead of attempting another candidate.
 */
export const isCleanupUnconfirmed = (error: { readonly code?: string | undefined }): boolean =>
  error.code?.endsWith("_cleanup_unconfirmed") === true;

export class SubagentProtocolError extends Schema.TaggedError<SubagentProtocolError>()(
  "SubagentProtocolError",
  { message: Schema.String },
) {}

export class SubagentRuntimeClosedError extends Schema.TaggedError<SubagentRuntimeClosedError>()(
  "SubagentRuntimeClosedError",
  { message: Schema.String },
) {}

export class UnsupportedSubagentCapabilityError extends Schema.TaggedError<UnsupportedSubagentCapabilityError>()(
  "UnsupportedSubagentCapabilityError",
  { backend: Schema.String, capability: Schema.String, message: Schema.String },
) {}

export type SubagentError =
  | InvalidSubagentRequestError
  | SubagentNotFoundError
  | SubagentCapacityError
  | SubagentHistoryCapacityError
  | SubagentWriterConflictError
  | UnsupportedSafeWriterOwnershipError
  | SubagentProcessError
  | SubagentProtocolError
  | SubagentRuntimeClosedError
  | UnsupportedSubagentCapabilityError;
