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
}) {}

export const boundaryError = (
  kind: McpBoundaryError["kind"],
  outcome: McpBoundaryError["outcome"],
  message: string,
): McpBoundaryError => new McpBoundaryError({ kind, outcome, message });
