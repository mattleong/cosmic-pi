import * as Schema from "effect/Schema";

/** A requested log level is observational; without request logging the call runs without it. */
export const MCP_LOGGING_UNAVAILABLE_NOTICE =
  "Request logging is unavailable on this connection, so the call ran without it.";
export const McpLogLevel = Schema.Literals([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);
export type McpLogLevel = typeof McpLogLevel.Type;
/** McpLogLevel lists its literals in RFC 5424 severity order, lowest first. */
export const logSeverity = (level: McpLogLevel): number => McpLogLevel.literals.indexOf(level);
export interface McpProgress {
  readonly progress: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}
export type McpRemoteEvent =
  | { readonly kind: "log"; readonly level: McpLogLevel; readonly message: string }
  | { readonly kind: "resource-updated"; readonly uri: string; readonly subscription?: symbol }
  | ({
      readonly kind: "progress";
      readonly operation: string;
      readonly leg?: number;
    } & McpProgress);
export interface McpObservedEvent {
  readonly cursor: string;
  readonly event: McpRemoteEvent;
}
export const MCP_OBSERVATION_LIMITS = Object.freeze({
  entries: 128,
  bytes: 128 * 1024,
  messageBytes: 4 * 1024,
});
