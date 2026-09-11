import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { McpBoundaryError } from "./errors.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const Cursor = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_192)));
const Arguments = Schema.Record(Schema.String, Schema.Json);

/** Closed, non-interactive SDK operations. No arbitrary protocol dispatch or auth actions. */
export const McpRequestSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("tools.list"), cursor: Cursor }),
  Schema.Struct({
    action: Schema.Literal("tools.call"),
    tool: Name,
    arguments: Schema.optionalKey(Arguments),
  }),
  Schema.Struct({ action: Schema.Literal("resources.list"), cursor: Cursor }),
  Schema.Struct({ action: Schema.Literal("resources.templates"), cursor: Cursor }),
  Schema.Struct({ action: Schema.Literal("resources.read"), uri: Name }),
  Schema.Struct({ action: Schema.Literal("prompts.list"), cursor: Cursor }),
  Schema.Struct({
    action: Schema.Literal("prompts.get"),
    prompt: Name,
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
]);

export const McpReplySchema = Schema.Struct({
  action: Schema.Literals([
    "tools.list",
    "tools.call",
    "resources.list",
    "resources.templates",
    "resources.read",
    "prompts.list",
    "prompts.get",
  ]),
  outcome: Schema.Literal("completed"),
  result: Schema.Json,
  cleanupUnconfirmed: Schema.optionalKey(Schema.Boolean),
});

export type McpRequest = typeof McpRequestSchema.Type;
export type McpReply = typeof McpReplySchema.Type;

export type McpMetadataFamily = "tools" | "resources" | "prompts";
export interface McpCapabilities {
  readonly tools: boolean;
  readonly resources: boolean;
  readonly prompts: boolean;
}
export interface McpConnectionHealth {
  readonly closed: boolean;
  readonly cleanupUnconfirmed: boolean;
}

export interface McpInstructions {
  readonly text: string;
  readonly truncated: boolean;
}

/** Session-owned internal connection. Tokens never enter public gateway contracts. */
export interface McpConnection {
  readonly capabilities: McpCapabilities;
  /** Negotiated by the completed SDK handshake; absent on injected connections. */
  readonly protocolVersion?: string | undefined;
  /** Bounded, untrusted initialize instructions. Absent differs from supplied empty text. */
  readonly instructions?: McpInstructions | undefined;
  /** One application consumer; each pending family is coalesced until delivery. */
  readonly changes: Stream.Stream<McpMetadataFamily>;
  /** Settles on local closure or terminal failure, not on individual request failure. */
  readonly terminal: Effect.Effect<void, McpBoundaryError>;
  readonly health: Effect.Effect<McpConnectionHealth>;
  readonly setToken: (token: string | undefined) => Effect.Effect<void, McpBoundaryError>;
  readonly request: (input: McpRequest) => Effect.Effect<McpReply, McpBoundaryError>;
  readonly close: Effect.Effect<void, McpBoundaryError>;
}

export const MCP_BOUNDARY_LIMITS = Object.freeze({
  instructionsBytes: 64 * 1024,
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  cleanupTimeoutMs: 2_000,
  requestBytes: 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  stderrBytes: 16 * 1024,
});
