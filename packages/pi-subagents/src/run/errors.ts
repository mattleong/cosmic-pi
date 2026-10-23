import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

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
  pendingDelivery: Schema.optional(Schema.Boolean),
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
  "agent_resume_unsupported",
  "agent_spend_limit",
  "agent_spend_limit_invalid",
] as const;
export type AgentMessageRefusalCode = (typeof AGENT_MESSAGE_REFUSAL_CODES)[number];

export const agentMessageRefusal = (
  code: AgentMessageRefusalCode,
  message: string,
): InvalidSubagentRequestError => invalidRequest(code, message);

export const runNotFound = (id: string): SubagentNotFoundError =>
  SubagentNotFoundError.make({ id, message: `Subagent run not found: ${id}` });

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
  error.code?.endsWith("_outcome_uncertain") === true;

export const isCleanupUnconfirmed = (error: { readonly code?: string | undefined }): boolean =>
  error.code?.endsWith("_cleanup_unconfirmed") === true;

/** The code of guidance whose native delivery is still being confirmed. */
export const PENDING_STEER_DELIVERY_CODE = "steer_outcome_uncertain";

export class SubagentProtocolError extends Schema.TaggedError<
  SubagentProtocolError,
  { readonly brand: unique symbol }
>()("SubagentProtocolError", { message: Schema.String }) {}

export class SubagentRuntimeClosedError extends Schema.TaggedError<
  SubagentRuntimeClosedError,
  { readonly brand: unique symbol }
>()("SubagentRuntimeClosedError", { message: Schema.String }) {}

export class UnsupportedSubagentCapabilityError extends Schema.TaggedError<
  UnsupportedSubagentCapabilityError,
  { readonly brand: unique symbol }
>()("UnsupportedSubagentCapabilityError", {
  backend: Schema.String,
  capability: Schema.String,
  message: Schema.String,
}) {}

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

/** Guidance that may already have arrived while its delivery is still being tracked. */
// A boolean, not a refinement: other process errors must stay in the remaining error channel.
export const isPendingSteerDelivery = (error: SubagentError): boolean =>
  Predicate.isTagged(error, "SubagentProcessError") &&
  error.pendingDelivery === true &&
  error.code === PENDING_STEER_DELIVERY_CODE;
