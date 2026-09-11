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
    Schema.Literals([
      "auth-not-configured",
      "auth-env-required",
      "auth-env-sign-in-unsupported",
      "auth-oauth-required",
      "oauth-resource-metadata-missing",
      "oauth-resource-metadata-invalid",
      "oauth-storage-unavailable",
      "oauth-mutation-unresolved",
      "oauth-browser-open-failed",
      "oauth-callback-timeout",
      "oauth-registration-unsupported",
      "oauth-binding-rejected",
      "oauth-deletion-failed",
      "oauth-finalization-failed",
      "rpc-method-not-found",
      "rpc-invalid-params",
      "rpc-invalid-request",
      "rpc-parse-error",
      "rpc-internal-error",
      "rpc-resource-not-found",
      "rpc-error",
    ]),
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
