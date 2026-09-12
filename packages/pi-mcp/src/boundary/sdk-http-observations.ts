import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { mcpCodeModeJsonFits } from "../code-mode/protocol.ts";
import { McpLogLevel, logSeverity, type McpRemoteEvent } from "../observations/model.ts";
import { remoteText } from "../observations/service.ts";

export interface SdkHttpLogScope {
  readonly threshold: McpLogLevel;
  readonly publish: (event: Extract<McpRemoteEvent, { kind: "log" }>) => void;
}
const Log = Schema.Struct({
  method: Schema.Literal("notifications/message"),
  params: Schema.Struct({
    level: McpLogLevel,
    data: Schema.Json,
  }),
});

/** Called only with exact native POST context, before terminal-response evidence. */
export const observeHttpLog = (
  message: JSONRPCMessage,
  scope: SdkHttpLogScope | undefined,
): void => {
  if (!scope || !("method" in message) || message.method !== "notifications/message") return;
  try {
    const decoded = Schema.decodeUnknownOption(Log)(message);
    if (
      Option.isNone(decoded) ||
      logSeverity[decoded.value.params.level] < logSeverity[scope.threshold]
    )
      return;
    const { data, level } = decoded.value.params;
    const text = Predicate.isString(data)
      ? data.slice(0, 16_384)
      : mcpCodeModeJsonFits(data, 16_384)
        ? JSON.stringify(data)
        : "Remote log data exceeded its bound.";
    scope.publish({ kind: "log", level, message: remoteText(text) });
  } catch {
    /* Observations cannot alter execution or produce diagnostics. */
  }
};
