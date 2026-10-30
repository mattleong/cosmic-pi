import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Failure text whose model copy adds an agent procedure the user's view never draws. `message` is
 * exactly what the model reads; `userMessage` is the same account without the procedure.
 */
export interface GuidedText {
  readonly message: string;
  readonly userMessage: string;
}

/** Plain text, which both readers read alike, as guided text. */
export const guidedText = (text: string | GuidedText): GuidedText =>
  Predicate.isString(text) ? { message: text, userMessage: text } : text;

const guided = guidedText;

/**
 * `text`, followed in the model's copy only by `guidance`: a sentence after a space by default, or
 * a line or paragraph of its own.
 */
export const withGuidance = (
  text: string | GuidedText,
  guidance: string,
  separator: " " | "\n" | "\n\n" = " ",
): GuidedText => {
  const { message, userMessage } = guided(text);
  return { message: `${message}${separator}${guidance}`, userMessage };
};

/** A `clause` ending in the model's copy with `; guidance` and in the user's with a period. */
export const withGuidanceClause = (clause: string, guidance: string): GuidedText => ({
  message: `${clause}; ${guidance}`,
  userMessage: `${clause}.`,
});

/** Appends `tail`, such as a cause, to both copies. */
export const appendShared = (text: string | GuidedText, tail: string): GuidedText => {
  const { message, userMessage } = guided(text);
  return { message: `${message}${tail}`, userMessage: `${userMessage}${tail}` };
};

/** `text`, then the error that caused it in parentheses, each copy with the cause's own copy. */
export const withCause = (
  text: string | GuidedText,
  cause: { readonly message: string; readonly userMessage?: string | undefined },
): GuidedText => {
  const { message, userMessage } = guided(text);
  return {
    message: `${message} (${cause.message})`,
    userMessage: `${userMessage} (${cause.userMessage ?? cause.message})`,
  };
};

/** What the user reads for a failure: its message without the agent procedure it carries. */
export const userFailureText = (failure: {
  readonly message: string;
  readonly userMessage?: string | undefined;
}): string => failure.userMessage ?? failure.message;

/** Both copies of an error's text, so a wrapper can extend them. */
export const errorText = (error: {
  readonly message: string;
  readonly userMessage?: string | undefined;
}): GuidedText => ({ message: error.message, userMessage: userFailureText(error) });

/** An error's text fields; the user copy is kept only where it differs. */
export const failureFields = (
  text: string | GuidedText,
): { readonly message: string; readonly userMessage?: string } => {
  const { message, userMessage } = guided(text);
  return userMessage === message ? { message } : { message, userMessage };
};

/** The user copy of an error, kept when a wrapper rewrites its model text. */
const keptUserMessage = (error: {
  readonly message: string;
  readonly userMessage?: string | undefined;
}) => ({ userMessage: userFailureText(error) });

export class InvalidSubagentRequestError extends Schema.TaggedError<
  InvalidSubagentRequestError,
  { readonly brand: unique symbol }
>()("InvalidSubagentRequestError", {
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
}) {}

export class SubagentNotFoundError extends Schema.TaggedError<
  SubagentNotFoundError,
  { readonly brand: unique symbol }
>()("SubagentNotFoundError", {
  id: Schema.String,
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
}) {}

export class SubagentCapacityError extends Schema.TaggedError<
  SubagentCapacityError,
  { readonly brand: unique symbol }
>()("SubagentCapacityError", {
  limit: Schema.Finite,
  code: Schema.optional(Schema.String),
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
}) {}

export class SubagentHistoryCapacityError extends Schema.TaggedError<
  SubagentHistoryCapacityError,
  { readonly brand: unique symbol }
>()("SubagentHistoryCapacityError", {
  limit: Schema.Finite,
  code: Schema.String,
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
}) {}

export class SubagentWriterConflictError extends Schema.TaggedError<
  SubagentWriterConflictError,
  { readonly brand: unique symbol }
>()("SubagentWriterConflictError", {
  activeId: Schema.String,
  activeName: Schema.String,
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
  transient: Schema.optional(Schema.Boolean),
}) {}

export class SubagentProcessError extends Schema.TaggedError<
  SubagentProcessError,
  { readonly brand: unique symbol }
>()("SubagentProcessError", {
  operation: Schema.String,
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
}) {}

export const processError = (
  operation: string,
  code: string,
  message: string | GuidedText,
): SubagentProcessError =>
  SubagentProcessError.make({ operation, code, ...failureFields(message) });

export const invalidRequest = (
  code: string,
  message: string | GuidedText,
): InvalidSubagentRequestError =>
  InvalidSubagentRequestError.make({ code, ...failureFields(message) });

/** Refusals of `agent_*` messaging; each is an `InvalidSubagentRequestError` code. */
export const AGENT_MESSAGE_REFUSAL_CODES = [
  "agent_self_target",
  "agent_not_found",
  "agent_unavailable",
] as const;
export type AgentMessageRefusalCode = (typeof AGENT_MESSAGE_REFUSAL_CODES)[number];

export const agentMessageRefusal = (
  code: AgentMessageRefusalCode,
  message: string | GuidedText,
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
    ? InvalidSubagentRequestError.make({
        code: error.code,
        message: `[${error.code}] ${error.message}`,
        ...keptUserMessage(error),
      })
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
          ...keptUserMessage(error),
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
      ...keptUserMessage(error),
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
>()("SubagentProtocolError", {
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
}) {}

export class SubagentRuntimeClosedError extends Schema.TaggedError<
  SubagentRuntimeClosedError,
  { readonly brand: unique symbol }
>()("SubagentRuntimeClosedError", {
  message: Schema.String,
  userMessage: Schema.optional(Schema.String),
}) {}

/** Whether a value is one of this package's typed failures, such as a rejected tool call's. */
export const isSubagentError = Schema.is(
  Schema.Union([
    InvalidSubagentRequestError,
    SubagentNotFoundError,
    SubagentCapacityError,
    SubagentHistoryCapacityError,
    SubagentWriterConflictError,
    SubagentProcessError,
    SubagentProtocolError,
    SubagentRuntimeClosedError,
  ]),
);

export type SubagentError =
  | InvalidSubagentRequestError
  | SubagentNotFoundError
  | SubagentCapacityError
  | SubagentHistoryCapacityError
  | SubagentWriterConflictError
  | SubagentProcessError
  | SubagentProtocolError
  | SubagentRuntimeClosedError;
