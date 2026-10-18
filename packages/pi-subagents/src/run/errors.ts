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
  { limit: Schema.Finite, code: Schema.optional(Schema.String), message: Schema.String },
) {}

export class SubagentHistoryCapacityError extends Schema.TaggedError<SubagentHistoryCapacityError>()(
  "SubagentHistoryCapacityError",
  { limit: Schema.Finite, code: Schema.String, message: Schema.String },
) {}

export class SubagentWriterConflictError extends Schema.TaggedError<SubagentWriterConflictError>()(
  "SubagentWriterConflictError",
  {
    activeId: Schema.String,
    activeName: Schema.String,
    message: Schema.String,
    transient: Schema.optional(Schema.Boolean),
  },
) {}

export class SubagentProcessError extends Schema.TaggedError<SubagentProcessError>()(
  "SubagentProcessError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.String),
    pendingDelivery: Schema.optional(Schema.Boolean),
  },
) {}

export const processError = (
  operation: string,
  code: string,
  message: string,
): SubagentProcessError => new SubagentProcessError({ operation, code, message });

export const invalidRequest = (code: string, message: string): InvalidSubagentRequestError =>
  new InvalidSubagentRequestError({ code, message });

/** Refusals of `agent_*` messaging; each is an `InvalidSubagentRequestError` code. */
export const AGENT_MESSAGE_REFUSAL_CODES = [
  "agent_self_target",
  "agent_not_found",
  "agent_unavailable",
  "agent_resume_unsupported",
  "agent_rate_limited",
  "agent_message_budget_exhausted",
  "agent_wake_budget_exhausted",
  "agent_spend_limit",
] as const;
export type AgentMessageRefusalCode = (typeof AGENT_MESSAGE_REFUSAL_CODES)[number];

export const agentMessageRefusal = (
  code: AgentMessageRefusalCode,
  message: string,
): InvalidSubagentRequestError => invalidRequest(code, message);

export const runNotFound = (id: string): SubagentNotFoundError =>
  new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` });

export const processCauseError = (
  operation: string,
  cause?: unknown,
  code?: string,
  fallbackMessage = `Unable to ${operation} subagent process.`,
): SubagentProcessError =>
  new SubagentProcessError({
    operation,
    message:
      cause instanceof Error ? cause.message : Predicate.isString(cause) ? cause : fallbackMessage,
    ...(code && { code }),
  });

export const subagentErrorCode = (error: SubagentError): string =>
  ("code" in error && Predicate.isString(error.code) && error.code !== "" && error.code) ||
  error._tag;

export const isOutcomeUncertain = (error: { readonly code?: string | undefined }): boolean =>
  error.code?.endsWith("_outcome_uncertain") === true;

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
  | SubagentProcessError
  | SubagentProtocolError
  | SubagentRuntimeClosedError
  | UnsupportedSubagentCapabilityError;
