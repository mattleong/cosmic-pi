import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OversizedLine } from "../boundary/bounded-line-parser.ts";
import { jsonPrefixScalars } from "../boundary/json-prefix.ts";
import { omittedOutputPreview } from "./driver-shared.ts";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_PROTOCOL_ID_CHARS } from "../run/limits.ts";

const MAX_PROTOCOL_NAME_CHARS = 256;
const MAX_PROTOCOL_ERROR_CHARS = 64 * 1024;
const MAX_PROXY_PAYLOAD_CHARS = 2 * 1024 * 1024;

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
  data: Schema.optional(Schema.Json),
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
  assistantMessageEvent: Schema.Struct({ type: ProtocolNameSchema }),
});
const MessageStartSchema = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({ role: Schema.String }),
});
const MessageEndSchema = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Json,
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
const ContactParentSchema = piSubagentsMessage("contact_request", {
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
  /**
   * The notice's stable identity across retries: a completion's run ID and generation, or a
   * question's run ID and notification generation. The parent shows each key once.
   */
  key: ProtocolIdSchema,
  message: Schema.String.check(Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS)),
});
const TurnInputBarrierSchema = piSubagentsMessage("turn_input_barrier", {
  requestId: ProtocolIdSchema,
});
const LocalPiContactSchema = Schema.Union([
  ContactParentSchema,
  ContactCancelSchema,
  ParentReplyAckSchema,
  ProxyRequestSchema,
  ProxyCancelSchema,
  ProxyNotificationAckSchema,
  TurnInputBarrierAckSchema,
]);
const LocalPiParentControlSchema = Schema.Union([
  ParentReplySchema,
  PeerNoticeSchema,
  ProxyResponseSchema,
  ProxyNotificationSchema,
  TurnInputBarrierSchema,
]);
export type LocalPiContact = typeof LocalPiContactSchema.Type;
export type LocalPiParentControl = typeof LocalPiParentControlSchema.Type;
export const decodeLocalPiContactOption = Schema.decodeUnknownOption(LocalPiContactSchema);
export const decodeLocalPiParentControlOption = Schema.decodeUnknownOption(
  LocalPiParentControlSchema,
);

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
export type RpcResponse = typeof RpcResponseSchema.Type;
export type RpcChildEnvelope =
  | typeof RpcEventSchema.Type
  | { readonly type: "ignored"; readonly eventType: string };

export const decodeRpcEnvelope = Effect.fnUntraced(function* (
  value: Schema.Json,
): Effect.fn.Return<RpcChildEnvelope, Schema.SchemaError> {
  const discriminant = yield* Schema.decodeUnknownEffect(RpcDiscriminantSchema)(value);
  if (RPC_EVENT_TYPES.has(discriminant.type ?? ""))
    return yield* Schema.decodeUnknownEffect(RpcEventSchema)(value);
  const ignored = yield* Schema.decodeUnknownEffect(IgnoredEventSchema)(value);
  return { type: "ignored" as const, eventType: ignored.type };
});

const OversizedRpcFieldsSchema = Schema.Struct({
  type: ProtocolNameSchema,
  toolCallId: Schema.optional(ProtocolIdSchema),
  toolName: Schema.optional(ProtocolNameSchema),
  "message.role": Schema.optional(ProtocolNameSchema),
});
const decodeOversizedRpcFields = Schema.decodeUnknownOption(OversizedRpcFieldsSchema);
// Pi writes `isError` after the tool result, optionally followed by `durationMs`.
const TOOL_END_ERROR_SUFFIX = /"isError":(true|false)(?:,"durationMs":[\d.eE+-]+)?\}$/;

/**
 * Pi repeats whole messages and tool results in aggregate, session, and tool events, so one large
 * image can push a line past the limit. The subagent needs none of those payloads. It keeps what
 * the leading fields identify and leaves every other oversized event a protocol error.
 */
export const oversizedRpcEnvelope = (line: OversizedLine): RpcChildEnvelope | undefined => {
  const fields = decodeOversizedRpcFields(Object.fromEntries(jsonPrefixScalars(line.prefix)));
  if (Option.isNone(fields)) return undefined;
  const { type, toolCallId, toolName, "message.role": role } = fields.value;
  switch (type) {
    case "agent_end":
      return { type };
    case "turn_end":
    case "entry_appended":
    case "tool_execution_update":
      return { type: "ignored", eventType: type };
    case "message_start":
    case "message_end":
      return role === undefined || role === "assistant"
        ? undefined
        : { type: "ignored", eventType: type };
    case "tool_execution_end":
      return toolCallId === undefined || toolName === undefined
        ? undefined
        : {
            type,
            toolCallId,
            toolName,
            isError: TOOL_END_ERROR_SUFFIX.exec(line.suffix)?.[1] === "true",
            result: omittedOutputPreview(line.bytes),
          };
  }
  return undefined;
};

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

type RpcStateData = typeof RpcStateDataSchema.Type;

export const decodeRpcStateData = Schema.decodeUnknownEffect(RpcStateDataSchema);

const RpcPromptDataSchema = Schema.Struct({
  disposition: Schema.Literals(["started", "queued", "handled"]),
});

export const decodeRpcPromptData = Schema.decodeUnknownEffect(RpcPromptDataSchema);

export const rpcStateModelId = (model: RpcStateData["model"]): string | undefined =>
  Predicate.isString(model) ? model : model ? `${model.provider}/${model.id}` : undefined;

const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  content: Schema.Array(Schema.Unknown),
  stopReason: Schema.optional(Schema.Literals(["stop", "length", "toolUse", "error", "aborted"])),
  errorMessage: Schema.optional(ProtocolErrorSchema),
  usage: Schema.optional(Schema.Unknown),
});
const MessageDiscriminantSchema = Schema.Struct({ role: Schema.optional(Schema.String) });

export const decodeAssistantMessage = Effect.fnUntraced(function* (value: Schema.Json) {
  const discriminant = yield* Schema.decodeUnknownEffect(MessageDiscriminantSchema)(value);
  if (discriminant.role !== "assistant") return undefined;
  return yield* Schema.decodeUnknownEffect(AssistantMessageSchema)(value);
});

const TextPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decodeTextPart = decodeUnknownOrUndefined(TextPartSchema);

/** The `provider/model` selector a reply came from; extensions can switch it mid-run. */
export const assistantModel = (message: typeof AssistantMessageSchema.Type): string | undefined => {
  const selector = `${message.provider ?? ""}/${message.model ?? ""}`;
  return message.provider && message.model && isSafeNativeModelSelector(selector)
    ? selector
    : undefined;
};

export const assistantText = (message: typeof AssistantMessageSchema.Type): string =>
  message.content
    .flatMap((part) => decodeTextPart(part)?.text ?? [])
    .join("\n")
    .trim();

type CorrelatedRpcCommand =
  | { readonly type: "get_state"; readonly id?: string | undefined }
  | { readonly type: "get_session_stats"; readonly id?: string | undefined }
  | {
      readonly type: "prompt";
      readonly id?: string | undefined;
      readonly message: string;
      readonly streamingBehavior?: "steer" | undefined;
    }
  | { readonly type: "clear_queue"; readonly id?: string | undefined }
  | { readonly type: "abort"; readonly id?: string | undefined };

export type RpcCommand =
  | CorrelatedRpcCommand
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };
