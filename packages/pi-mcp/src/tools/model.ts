import * as Schema from "effect/Schema";
import type { McpProgress } from "../observations/model.ts";
import { McpLogLevel } from "../observations/model.ts";
import { McpCompletionFields } from "../client/model.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const Server = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Cursor = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_192)));
const Limit = Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const Page = { cursor: Cursor, limit: Limit };
const Logging = { logLevel: Schema.optionalKey(McpLogLevel) };

/** Both entry points accept only these operations. Management is added only to the gateway. */
export const McpDataRequestSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("completion.complete"),
    server: Server,
    ...McpCompletionFields,
    ...Logging,
  }),
  Schema.Struct({ action: Schema.Literal("events.read"), server: Server, ...Page }),
  Schema.Struct({ action: Schema.Literal("resources.subscribe"), server: Server, uri: Name }),
  Schema.Struct({ action: Schema.Literal("resources.unsubscribe"), server: Server, uri: Name }),
  Schema.Struct({ action: Schema.Literal("resources.subscriptions"), server: Server }),
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("server.instructions"), server: Server }),
  Schema.Struct({
    action: Schema.Literal("tools.list"),
    server: Schema.optionalKey(Server),
    ...Page,
  }),
  Schema.Struct({
    action: Schema.Literal("tools.search"),
    query: Schema.String.check(Schema.isMaxLength(1_024)),
    server: Schema.optionalKey(Server),
    ...Page,
  }),
  Schema.Struct({ action: Schema.Literal("tools.describe"), server: Server, tool: Name }),
  Schema.Struct({
    action: Schema.Literal("tools.call"),
    ...Logging,
    server: Server,
    tool: Name,
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  Schema.Struct({ action: Schema.Literal("resources.list"), server: Server, ...Page }),
  Schema.Struct({ action: Schema.Literal("resources.templates"), server: Server, ...Page }),
  Schema.Struct({
    action: Schema.Literal("resources.read"),
    server: Server,
    uri: Name,
    ...Logging,
  }),
  Schema.Struct({ action: Schema.Literal("prompts.list"), server: Server, ...Page }),
  Schema.Struct({
    action: Schema.Literal("prompts.get"),
    ...Logging,
    server: Server,
    prompt: Name,
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal("result.read"),
    id: Name,
    offset: Schema.optionalKey(Schema.Natural),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50_000 }))),
    attachment: Schema.optionalKey(Schema.Natural),
  }),
]);

export const McpManagementRequestSchema = Schema.Struct({
  action: Schema.Literals(["connect", "disconnect", "refresh"]),
  server: Server,
});
export const McpGatewayRequestSchema = Schema.Union([
  McpDataRequestSchema,
  McpManagementRequestSchema,
]);
export type McpDataRequest = typeof McpDataRequestSchema.Type;
export type McpGatewayRequest = typeof McpGatewayRequestSchema.Type;
/** Model-facing order of every gateway action; the Pi tool schema lists them in this order. */
export const MCP_GATEWAY_ACTIONS = [
  "status",
  "connect",
  "disconnect",
  "refresh",
  "server.instructions",
  "completion.complete",
  "events.read",
  "resources.subscribe",
  "resources.unsubscribe",
  "resources.subscriptions",
  "tools.list",
  "tools.search",
  "tools.describe",
  "tools.call",
  "resources.list",
  "resources.templates",
  "resources.read",
  "prompts.list",
  "prompts.get",
  "result.read",
] as const satisfies ReadonlyArray<McpGatewayRequest["action"]>;

export const McpGatewayReplySchema = Schema.Struct({
  action: Schema.String.check(Schema.isMaxLength(64)),
  outcome: Schema.Literals(["not-sent", "completed", "unknown"]),
  isError: Schema.Boolean,
  data: Schema.Json,
  resultId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  notices: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(16)),
});
export type McpGatewayReply = typeof McpGatewayReplySchema.Type;

/** Images never cross the Code Mode JSON capability. */
export interface McpImage {
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
}
export interface McpGatewayExecution {
  readonly reply: McpGatewayReply;
  readonly images: ReadonlyArray<McpImage>;
}
export interface McpProjectionOptions {
  readonly maxOutputBytes: number;
  readonly images: boolean;
  /** Private top-level host callback. Never part of a gateway or Code Mode request. */
  readonly onProgress?: (progress: McpProgress) => void;
}
export const MCP_INLINE_BYTES = 50 * 1024;
