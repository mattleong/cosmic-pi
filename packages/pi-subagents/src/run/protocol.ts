import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MAX_PARENT_MESSAGE_CHARS, MAX_PROTOCOL_ID_CHARS } from "./limits.ts";

const MAX_PROTOCOL_NAME_CHARS = 256;
const MAX_PROTOCOL_ERROR_CHARS = 64 * 1024;
const MAX_MESSAGE_DELTA_CHARS = 1024 * 1024;

const ProtocolIdSchema = Schema.String.check(Schema.isMaxLength(MAX_PROTOCOL_ID_CHARS));
const ProtocolNameSchema = Schema.String.check(Schema.isMaxLength(MAX_PROTOCOL_NAME_CHARS));
const ProtocolErrorSchema = Schema.String.check(Schema.isMaxLength(MAX_PROTOCOL_ERROR_CHARS));
const ParentMessageSchema = Schema.String.check(Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS));

const RpcResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.optional(ProtocolIdSchema),
  command: ProtocolNameSchema,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(ProtocolErrorSchema),
});

const AgentStartSchema = Schema.Struct({ type: Schema.Literal("agent_start") });
const AgentEndSchema = Schema.Struct({
  type: Schema.Literal("agent_end"),
  willRetry: Schema.optional(Schema.Boolean),
});
const AgentSettledSchema = Schema.Struct({ type: Schema.Literal("agent_settled") });
const MessageUpdateSchema = Schema.Struct({
  type: Schema.Literal("message_update"),
  assistantMessageEvent: Schema.Struct({
    type: ProtocolNameSchema,
    delta: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_DELTA_CHARS))),
  }),
});
const MessageEndSchema = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Unknown,
});
const ToolStartSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: ProtocolIdSchema,
  toolName: ProtocolNameSchema,
  args: Schema.Unknown,
});
const ToolEndSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: ProtocolIdSchema,
  toolName: ProtocolNameSchema,
  result: Schema.Unknown,
  isError: Schema.Boolean,
});
const ExtensionErrorSchema = Schema.Struct({
  type: Schema.Literal("extension_error"),
  error: ProtocolErrorSchema,
});
const ExtensionUiRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: ProtocolIdSchema,
  method: ProtocolNameSchema,
});
const ContactParentSchema = Schema.Struct({
  channel: Schema.Literal("pi-subagents"),
  type: Schema.Literal("contact_parent"),
  requestId: ProtocolIdSchema,
  kind: Schema.Union([
    Schema.Literal("progress"),
    Schema.Literal("question"),
    Schema.Literal("warning"),
  ]),
  message: ParentMessageSchema,
});
const IgnoredEventSchema = Schema.Struct({ type: Schema.String });
const RpcDiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });
const IpcDiscriminantSchema = Schema.Struct({
  channel: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
});

export type RpcResponse = Schema.Schema.Type<typeof RpcResponseSchema>;
export type ContactParentEnvelope = Schema.Schema.Type<typeof ContactParentSchema>;
export type RpcChildEnvelope =
  | RpcResponse
  | Schema.Schema.Type<typeof AgentStartSchema>
  | Schema.Schema.Type<typeof AgentEndSchema>
  | Schema.Schema.Type<typeof AgentSettledSchema>
  | Schema.Schema.Type<typeof MessageUpdateSchema>
  | Schema.Schema.Type<typeof MessageEndSchema>
  | Schema.Schema.Type<typeof ToolStartSchema>
  | Schema.Schema.Type<typeof ToolEndSchema>
  | Schema.Schema.Type<typeof ExtensionErrorSchema>
  | Schema.Schema.Type<typeof ExtensionUiRequestSchema>
  | { readonly type: "ignored"; readonly eventType: string };

export type ChildEnvelope = RpcChildEnvelope | ContactParentEnvelope;

export const decodeContactParentEnvelope = (value: unknown) =>
  Schema.decodeUnknownEffect(ContactParentSchema)(value);

export function decodeRpcEnvelope(
  value: unknown,
): Effect.Effect<RpcChildEnvelope, Schema.SchemaError> {
  return Effect.gen(function* () {
    const discriminant = yield* Schema.decodeUnknownEffect(RpcDiscriminantSchema)(value);
    switch (discriminant.type) {
      case "response":
        return yield* Schema.decodeUnknownEffect(RpcResponseSchema)(value);
      case "agent_start":
        return yield* Schema.decodeUnknownEffect(AgentStartSchema)(value);
      case "agent_end":
        return yield* Schema.decodeUnknownEffect(AgentEndSchema)(value);
      case "agent_settled":
        return yield* Schema.decodeUnknownEffect(AgentSettledSchema)(value);
      case "message_update":
        return yield* Schema.decodeUnknownEffect(MessageUpdateSchema)(value);
      case "message_end":
        return yield* Schema.decodeUnknownEffect(MessageEndSchema)(value);
      case "tool_execution_start":
        return yield* Schema.decodeUnknownEffect(ToolStartSchema)(value);
      case "tool_execution_end":
        return yield* Schema.decodeUnknownEffect(ToolEndSchema)(value);
      case "extension_error":
        return yield* Schema.decodeUnknownEffect(ExtensionErrorSchema)(value);
      case "extension_ui_request":
        return yield* Schema.decodeUnknownEffect(ExtensionUiRequestSchema)(value);
      default: {
        const ignored = yield* Schema.decodeUnknownEffect(IgnoredEventSchema)(value);
        return { type: "ignored" as const, eventType: ignored.type };
      }
    }
  });
}

export function decodeChildEnvelope(
  value: unknown,
): Effect.Effect<ChildEnvelope, Schema.SchemaError> {
  return Effect.gen(function* () {
    const ipc = yield* Schema.decodeUnknownEffect(IpcDiscriminantSchema)(value);
    return ipc.channel === "pi-subagents" && ipc.type === "contact_parent"
      ? yield* decodeContactParentEnvelope(value)
      : yield* decodeRpcEnvelope(value);
  });
}

const EffortSchema = Schema.Union([
  Schema.Literal("off"),
  Schema.Literal("minimal"),
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
]);
const RpcStateModelSchema = Schema.Struct({
  provider: ProtocolNameSchema,
  id: ProtocolNameSchema,
});
const RpcStateModelIdSchema = Schema.String.check(Schema.isMaxLength(512));
const RpcStateSessionIdSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PROTOCOL_ID_CHARS),
);
const RpcStateSessionFileSchema = Schema.String.check(Schema.isMaxLength(64 * 1024));
const RpcStateDataSchema = Schema.Struct({
  thinkingLevel: EffortSchema,
  model: Schema.optional(Schema.Union([RpcStateModelIdSchema, RpcStateModelSchema])),
  sessionFile: Schema.optional(RpcStateSessionFileSchema),
  sessionId: RpcStateSessionIdSchema,
});

export type RpcStateData = Schema.Schema.Type<typeof RpcStateDataSchema>;

export const decodeRpcStateData = (value: unknown) =>
  Schema.decodeUnknownEffect(RpcStateDataSchema)(value);

export const rpcStateModelId = (model: RpcStateData["model"]): string | undefined =>
  typeof model === "string" ? model : model ? `${model.provider}/${model.id}` : undefined;

const UsageTokenSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const UsageCostSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const UsageSchema = Schema.Struct({
  input: Schema.optional(UsageTokenSchema),
  output: Schema.optional(UsageTokenSchema),
  cacheRead: Schema.optional(UsageTokenSchema),
  cacheWrite: Schema.optional(UsageTokenSchema),
  totalTokens: Schema.optional(UsageTokenSchema),
  cost: Schema.optional(
    Schema.Struct({
      total: Schema.optional(UsageCostSchema),
    }),
  ),
});
export type RpcUsage = Schema.Schema.Type<typeof UsageSchema>;
export const decodeRpcUsageOption = (value: unknown): RpcUsage | undefined => {
  const decoded = Schema.decodeUnknownOption(UsageSchema)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};
const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
  // Usage is decoded independently so malformed accounting cannot discard an
  // otherwise valid assistant message or fail the run.
  usage: Schema.optional(Schema.Unknown),
});
const MessageDiscriminantSchema = Schema.Struct({ role: Schema.optional(Schema.String) });

export const decodeAssistantMessage = Effect.fn("SubagentProtocol.decodeAssistantMessage")(
  function* (value: unknown) {
    const discriminant = yield* Schema.decodeUnknownEffect(MessageDiscriminantSchema)(value);
    if (discriminant.role !== "assistant") return undefined;
    return yield* Schema.decodeUnknownEffect(AssistantMessageSchema)(value);
  },
);

const TextPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

export const assistantText = (message: Schema.Schema.Type<typeof AssistantMessageSchema>): string =>
  message.content
    .flatMap((part) => {
      const decoded = Schema.decodeUnknownOption(TextPartSchema)(part);
      return decoded._tag === "Some" ? [decoded.value.text] : [];
    })
    .join("\n")
    .trim();

export type RpcCommand = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly id?: string;
};

export interface PeerNotice {
  readonly channel: "pi-subagents";
  readonly type: "peer_notice";
  readonly message: string;
}

export interface ParentReply {
  readonly channel: "pi-subagents";
  readonly type: "parent_reply";
  readonly requestId: string;
  readonly message: string;
}
