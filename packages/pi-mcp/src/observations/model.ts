import * as Schema from "effect/Schema";

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
export const logSeverity = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
} as const satisfies Readonly<Record<McpLogLevel, number>>;
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
