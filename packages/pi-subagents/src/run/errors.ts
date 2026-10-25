import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export class InvalidSubagentRequestError extends Schema.TaggedError<
  InvalidSubagentRequestError,
  { readonly brand: unique symbol }
>()("InvalidSubagentRequestError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

export class SubagentNotFoundError extends Schema.TaggedError<
  SubagentNotFoundError,
  { readonly brand: unique symbol }
>()("SubagentNotFoundError", { id: Schema.String, message: Schema.String }) {}

export class SubagentCapacityError extends Schema.TaggedError<
  SubagentCapacityError,
  { readonly brand: unique symbol }
>()("SubagentCapacityError", {
  limit: Schema.Finite,
  code: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export class SubagentHistoryCapacityError extends Schema.TaggedError<
  SubagentHistoryCapacityError,
  { readonly brand: unique symbol }
>()("SubagentHistoryCapacityError", {
  limit: Schema.Finite,
  code: Schema.String,
  message: Schema.String,
}) {}

export class SubagentWriterConflictError extends Schema.TaggedError<
  SubagentWriterConflictError,
  { readonly brand: unique symbol }
>()("SubagentWriterConflictError", {
  activeId: Schema.String,
  activeName: Schema.String,
  message: Schema.String,
  transient: Schema.optional(Schema.Boolean),
}) {}

export class SubagentProcessError extends Schema.TaggedError<
  SubagentProcessError,
  { readonly brand: unique symbol }
>()("SubagentProcessError", {
  operation: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

export const processError = (
  operation: string,
  code: string,
  message: string,
): SubagentProcessError => SubagentProcessError.make({ operation, code, message });

export const invalidRequest = (code: string, message: string): InvalidSubagentRequestError =>
  InvalidSubagentRequestError.make({ code, message });

/** Refusals of `agent_*` messaging; each is an `InvalidSubagentRequestError` code. */
export const AGENT_MESSAGE_REFUSAL_CODES = [
  "agent_self_target",
  "agent_not_found",
  "agent_unavailable",
] as const;
export type AgentMessageRefusalCode = (typeof AGENT_MESSAGE_REFUSAL_CODES)[number];

export const agentMessageRefusal = (
  code: AgentMessageRefusalCode,
  message: string,
): InvalidSubagentRequestError => invalidRequest(code, message);

export const runNotFound = (id: string): SubagentNotFoundError =>
  SubagentNotFoundError.make({ id, message: `Subagent run not found: ${id}` });

/** The calling run, not a target, is gone; refreshing target IDs can't help it. */
export const callerNotRegistered = (id: string): InvalidSubagentRequestError =>
  invalidRequest(
    "caller_not_registered",
    `The calling run ${id} is no longer registered in this session.`,
  );

const hasCodePrefix = (message: string, code: string): boolean =>
  Fn.pipe(message, Str.startsWith(`[${code}]`));

export const codedRefusal = (error: InvalidSubagentRequestError): InvalidSubagentRequestError =>
  error.code !== undefined && !hasCodePrefix(error.message, error.code)
    ? invalidRequest(error.code, `[${error.code}] ${error.message}`)
    : error;

/** The code a run-not-found failure carries in its tool text. */
const RUN_NOT_FOUND_CODE = "subagent_run_not_found";

/**
 * Failures carry their code in the text, the only part of a thrown tool error Pi keeps, so the
 * renderer can classify them without parsing the IDs they name.
 */
export const codedFailure = (error: SubagentError): SubagentError => {
  if (Predicate.isTagged(error, "InvalidSubagentRequestError")) return codedRefusal(error);
  if (Predicate.isTagged(error, "SubagentNotFoundError"))
    return hasCodePrefix(error.message, RUN_NOT_FOUND_CODE)
      ? error
      : SubagentNotFoundError.make({
          id: error.id,
          message: `[${RUN_NOT_FOUND_CODE}] ${error.message}`,
        });
  if (
    Predicate.isTagged(error, "SubagentProcessError") &&
    error.code !== undefined &&
    !hasCodePrefix(error.message, error.code)
  )
    return SubagentProcessError.make({
      operation: error.operation,
      code: error.code,
      message: `[${error.code}] ${error.message}`,
    });
  return error;
};

export const processCauseError = (
  operation: string,
  cause?: unknown,
  code?: string,
  fallbackMessage = `Unable to ${operation} subagent process.`,
): SubagentProcessError =>
  SubagentProcessError.make({
    operation,
    message:
      cause instanceof Error ? cause.message : Predicate.isString(cause) ? cause : fallbackMessage,
    ...(code && { code }),
  });

export const subagentErrorCode = (error: SubagentError): string =>
  ("code" in error && Predicate.isString(error.code) && error.code !== "" && error.code) ||
  error._tag;

export const isOutcomeUncertain = (error: { readonly code?: string | undefined }): boolean =>
  error.code !== undefined && Fn.pipe(error.code, Str.endsWith("_outcome_uncertain"));

export const isCleanupUnconfirmed = (error: { readonly code?: string | undefined }): boolean =>
  error.code !== undefined && Fn.pipe(error.code, Str.endsWith("_cleanup_unconfirmed"));

export class SubagentProtocolError extends Schema.TaggedError<
  SubagentProtocolError,
  { readonly brand: unique symbol }
>()("SubagentProtocolError", { message: Schema.String }) {}

export class SubagentRuntimeClosedError extends Schema.TaggedError<
  SubagentRuntimeClosedError,
  { readonly brand: unique symbol }
>()("SubagentRuntimeClosedError", { message: Schema.String }) {}

export type SubagentError =
  | InvalidSubagentRequestError
  | SubagentNotFoundError
  | SubagentCapacityError
  | SubagentHistoryCapacityError
  | SubagentWriterConflictError
  | SubagentProcessError
  | SubagentProtocolError
  | SubagentRuntimeClosedError;
