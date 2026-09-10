import * as Schema from "effect/Schema";

/** Bounded application failure. Raw SDK errors and credentials never enter this channel. */
export class McpBoundaryError extends Schema.TaggedError<McpBoundaryError>()("McpBoundaryError", {
  kind: Schema.Literals([
    "unavailable",
    "invalid-input",
    "connection",
    "transport",
    "protocol",
    "output-limit",
    "cancelled",
    "timeout",
    "cleanup",
    "auth-required",
    "denied",
    "not-found",
    "stale",
    "busy",
    "config",
    "unsupported",
  ]),
  outcome: Schema.Literals(["not-sent", "completed", "unknown"]),
  message: Schema.String,
  reason: Schema.optionalKey(
    Schema.Literals(["oauth-resource-metadata-missing", "oauth-resource-metadata-invalid"]),
  ),
}) {}

export const boundaryError = (
  kind: McpBoundaryError["kind"],
  outcome: McpBoundaryError["outcome"],
  message: string,
  reason?: McpBoundaryError["reason"],
): McpBoundaryError => {
  const fields = { kind, outcome, message };
  return new McpBoundaryError(reason === undefined ? fields : { ...fields, reason });
};
