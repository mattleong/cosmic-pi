import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const RpcResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.optional(Schema.String),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
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
    type: Schema.String,
    delta: Schema.optional(Schema.String),
  }),
});
const MessageEndSchema = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Unknown,
});
const ToolStartSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
});
const ToolEndSchema = Schema.Struct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.Unknown,
  isError: Schema.Boolean,
});
const ExtensionErrorSchema = Schema.Struct({
  type: Schema.Literal("extension_error"),
  error: Schema.String,
});
const ExtensionUiRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.String,
});
const ContactParentSchema = Schema.Struct({
  channel: Schema.Literal("pi-subagents"),
  type: Schema.Literal("contact_parent"),
  requestId: Schema.String,
  kind: Schema.Union([
    Schema.Literal("progress"),
    Schema.Literal("question"),
    Schema.Literal("warning"),
  ]),
  message: Schema.String,
});
const IgnoredEventSchema = Schema.Struct({ type: Schema.String });
const RpcDiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });
const IpcDiscriminantSchema = Schema.Struct({
  channel: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
});

export type RpcResponse = Schema.Schema.Type<typeof RpcResponseSchema>;
export type ContactParentEnvelope = Schema.Schema.Type<typeof ContactParentSchema>;
export type ChildEnvelope =
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
  | ContactParentEnvelope
  | { readonly type: "ignored"; readonly eventType: string };

export function decodeChildEnvelope(
  value: unknown,
): Effect.Effect<ChildEnvelope, Schema.SchemaError> {
  return Effect.gen(function* () {
    const ipc = yield* Schema.decodeUnknownEffect(IpcDiscriminantSchema)(value);
    if (ipc.channel === "pi-subagents" && ipc.type === "contact_parent")
      return yield* Schema.decodeUnknownEffect(ContactParentSchema)(value);

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

const EffortSchema = Schema.Union([
  Schema.Literal("off"),
  Schema.Literal("minimal"),
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
]);
const RpcStateDataSchema = Schema.Struct({
  thinkingLevel: EffortSchema,
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
});

export const decodeRpcStateData = (value: unknown) =>
  Schema.decodeUnknownEffect(RpcStateDataSchema)(value);

const UsageSchema = Schema.Struct({
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(
    Schema.Struct({
      total: Schema.optional(Schema.Number),
    }),
  ),
});
const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
  usage: Schema.optional(UsageSchema),
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
