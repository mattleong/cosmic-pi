import * as Predicate from "effect/Predicate";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_PROTOCOL_ID_CHARS } from "../run/limits.ts";

const MAX_PROTOCOL_NAME_CHARS = 256;
const MAX_PROTOCOL_ERROR_CHARS = 64 * 1024;
const MAX_MESSAGE_DELTA_CHARS = 1024 * 1024;
const MAX_PROXY_PAYLOAD_CHARS = 2 * 1024 * 1024;
/** Submitted result arguments; the contract bounds the value itself. */
export const MAX_STRUCTURED_RESULT_WIRE_CHARS = 64 * 1024;
export const MAX_STRUCTURED_RESULT_REJECTION_CHARS = 2_048;

const ProtocolIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PROTOCOL_ID_CHARS),
);
const ProtocolNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PROTOCOL_NAME_CHARS),
);
const ProtocolErrorSchema = Schema.String.check(Schema.isMaxLength(MAX_PROTOCOL_ERROR_CHARS));
const ParentMessageSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS),
);

/** One `pi-subagents` IPC message: the channel and type literals, then its own fields. */
const piSubagentsMessage = <const Type extends string, const Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) =>
  Schema.Struct({ channel: Schema.Literal("pi-subagents"), type: Schema.Literal(type), ...fields });

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
const MessageStartSchema = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({ role: Schema.String }),
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
const ContactParentSchema = piSubagentsMessage("contact_parent", {
  requestId: ProtocolIdSchema,
  kind: Schema.Literals(["progress", "question", "warning"]),
  message: ParentMessageSchema,
});
const ContactCancelSchema = piSubagentsMessage("contact_cancel", { requestId: ProtocolIdSchema });
const ProxyRequestSchema = piSubagentsMessage("proxy_request", {
  requestId: ProtocolIdSchema,
  tool: ProtocolNameSchema,
  argumentsJson: Schema.String.check(Schema.isMaxLength(MAX_PROXY_PAYLOAD_CHARS)),
});
const ProxyCancelSchema = piSubagentsMessage("proxy_cancel", { requestId: ProtocolIdSchema });
const ProxyNotificationAckSchema = piSubagentsMessage("proxy_notification_ack", {
  requestId: ProtocolIdSchema,
  ok: Schema.Boolean,
});
const TurnInputBarrierAckSchema = piSubagentsMessage("turn_input_barrier_ack", {
  requestId: ProtocolIdSchema,
});
const ParentReplySchema = piSubagentsMessage("parent_reply", {
  requestId: ProtocolIdSchema,
  ackId: ProtocolIdSchema,
  message: Schema.String.check(Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS)),
});
const ParentReplyAckSchema = piSubagentsMessage("parent_reply_ack", {
  requestId: ProtocolIdSchema,
  ok: Schema.Boolean,
});
const PeerNoticeSchema = piSubagentsMessage("peer_notice", {
  message: Schema.String.check(Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS)),
});
const ProxyResponseSchema = piSubagentsMessage("proxy_response", {
  requestId: ProtocolIdSchema,
  ok: Schema.Boolean,
  payloadJson: Schema.String.check(Schema.isMaxLength(MAX_PROXY_PAYLOAD_CHARS)),
});
const ProxyNotificationSchema = piSubagentsMessage("proxy_notification", {
  requestId: ProtocolIdSchema,
  message: Schema.String.check(Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS)),
});
const TurnInputBarrierSchema = piSubagentsMessage("turn_input_barrier", {
  requestId: ProtocolIdSchema,
});
const StructuredResultSchema = piSubagentsMessage("structured_result", {
  requestId: ProtocolIdSchema,
  valueJson: Schema.String.check(Schema.isMaxLength(MAX_STRUCTURED_RESULT_WIRE_CHARS)),
});
const StructuredResultAckSchema = piSubagentsMessage("structured_result_ack", {
  requestId: ProtocolIdSchema,
  ok: Schema.Boolean,
  message: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_STRUCTURED_RESULT_REJECTION_CHARS)),
  ),
});
export const LocalPiContactSchema = Schema.Union([
  ContactParentSchema,
  ContactCancelSchema,
  ParentReplyAckSchema,
  ProxyRequestSchema,
  ProxyCancelSchema,
  ProxyNotificationAckSchema,
  TurnInputBarrierAckSchema,
  StructuredResultSchema,
]);
export const LocalPiParentControlSchema = Schema.Union([
  ParentReplySchema,
  PeerNoticeSchema,
  ProxyResponseSchema,
  ProxyNotificationSchema,
  TurnInputBarrierSchema,
  StructuredResultAckSchema,
]);
export type LocalPiContact = Schema.Schema.Type<typeof LocalPiContactSchema>;
export type LocalPiParentControl = Schema.Schema.Type<typeof LocalPiParentControlSchema>;
export const decodeLocalPiContactOption = Schema.decodeUnknownOption(LocalPiContactSchema);
export const decodeLocalPiParentControlOption = Schema.decodeUnknownOption(
  LocalPiParentControlSchema,
);

/** Names the private result contract file of a launch; the child reads it at session start. */
export const LOCAL_PI_RESULT_CONTRACT_FLAG = "pi-subagents-result-schema";

/** The private file a launch with a result contract hands its local Pi child. */
export const LocalPiResultContractDocument = Schema.Struct({
  parameters: Schema.Record(Schema.String, Schema.Json),
  strictSafe: Schema.Boolean,
});
export type LocalPiResultContractDocument = typeof LocalPiResultContractDocument.Type;

const IgnoredEventSchema = Schema.Struct({ type: Schema.String });
const RpcDiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });
const RpcEventSchema = Schema.Union([
  RpcResponseSchema,
  AgentStartSchema,
  AgentEndSchema,
  AgentSettledSchema,
  MessageUpdateSchema,
  MessageEndSchema,
  MessageStartSchema,
  ToolStartSchema,
  ToolEndSchema,
  ExtensionErrorSchema,
  ExtensionUiRequestSchema,
]);
const RPC_EVENT_TYPES: ReadonlySet<string> = new Set(
  RpcEventSchema.members.map((member) => member.fields.type.literal),
);
export type RpcResponse = Schema.Schema.Type<typeof RpcResponseSchema>;
export type RpcChildEnvelope =
  | typeof RpcEventSchema.Type
  | { readonly type: "ignored"; readonly eventType: string };

/** Known event types decode strictly; any other typed event is ignored. */
export function decodeRpcEnvelope<ValueInput>(
  value: ValueInput,
): Effect.Effect<RpcChildEnvelope, Schema.SchemaError> {
  return Effect.gen(function* () {
    const discriminant = yield* Schema.decodeUnknownEffect(RpcDiscriminantSchema)(value);
    if (RPC_EVENT_TYPES.has(discriminant.type ?? ""))
      return yield* Schema.decodeUnknownEffect(RpcEventSchema)(value);
    const ignored = yield* Schema.decodeUnknownEffect(IgnoredEventSchema)(value);
    return { type: "ignored" as const, eventType: ignored.type };
  });
}

const EffortSchema = Schema.Literals(SUBAGENT_EFFORTS);
const RpcStateModelSchema = Schema.Struct({
  provider: ProtocolNameSchema,
  id: ProtocolNameSchema,
});
const RpcStateModelIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
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

export const decodeRpcStateData = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(RpcStateDataSchema)(value);

export const rpcStateModelId = (model: RpcStateData["model"]): string | undefined =>
  Predicate.isString(model) ? model : model ? `${model.provider}/${model.id}` : undefined;

const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
  stopReason: Schema.optional(Schema.Literals(["stop", "length", "toolUse", "error", "aborted"])),
  errorMessage: Schema.optional(ProtocolErrorSchema),
  // Usage is decoded independently so malformed accounting cannot discard an
  // otherwise valid assistant message or fail the run.
  usage: Schema.optional(Schema.Unknown),
});
const MessageDiscriminantSchema = Schema.Struct({ role: Schema.optional(Schema.String) });

export const decodeAssistantMessage = Effect.fn("SubagentProtocol.decodeAssistantMessage")(
  function* <ValueInput>(value: ValueInput) {
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

type CorrelatedRpcCommand =
  | { readonly type: "get_state"; readonly id?: string | undefined }
  | { readonly type: "get_session_stats"; readonly id?: string | undefined }
  | { readonly type: "prompt"; readonly id?: string | undefined; readonly message: string }
  | { readonly type: "steer"; readonly id?: string | undefined; readonly message: string }
  | { readonly type: "clear_queue"; readonly id?: string | undefined }
  | { readonly type: "abort"; readonly id?: string | undefined }
  | { readonly type: "set_session_name"; readonly id?: string | undefined; readonly name: string };

export type RpcCommand =
  | CorrelatedRpcCommand
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };
