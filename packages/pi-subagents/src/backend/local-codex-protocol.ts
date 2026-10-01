import { FAST_SERVICE_TIER } from "pi-better-openai/fast-models";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_ID_CHARS = 256;
const MAX_METHOD_CHARS = 128;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_WARNING_TEXT_CHARS = 16 * 1024;
const MAX_FILE_CHANGE_PATH_CHARS = 4_096;
const MAX_FILE_CHANGES = 256;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ID_CHARS));
const Method = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_METHOD_CHARS));
const Text = Schema.String.check(Schema.isMaxLength(MAX_TEXT_CHARS));
const Count = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const RequestId = Schema.Union([Id, Count]);

const Response = Schema.Struct({
  id: RequestId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number.check(Schema.isFinite(), Schema.isInt()),
      message: Text,
      data: Schema.optional(Schema.Unknown),
    }),
  ),
});
const Notification = Schema.Struct({ method: Method, params: Schema.optional(Schema.Unknown) });
const ServerRequest = Schema.Struct({
  id: RequestId,
  method: Method,
  params: Schema.optional(Schema.Unknown),
});
const EnvelopeDiscriminant = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  method: Schema.optional(Schema.Unknown),
});

export type CodexEnvelope =
  | {
      readonly type: "response";
      readonly id: string | number;
      readonly result?: unknown;
      readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
    }
  | { readonly type: "notification"; readonly method: string; readonly params?: unknown }
  | { readonly type: "server_request"; readonly id: string | number; readonly method: string };

export const decodeCodexEnvelope = Effect.fn("LocalCodexProtocol.decodeEnvelope")(function* <
  ValueInput,
>(value: ValueInput) {
  const discriminant = yield* Schema.decodeUnknownEffect(EnvelopeDiscriminant)(value);
  if (discriminant.method !== undefined && discriminant.id !== undefined) {
    const request = yield* Schema.decodeUnknownEffect(ServerRequest)(value);
    const envelope: CodexEnvelope = {
      type: "server_request",
      id: request.id,
      method: request.method,
    };
    return envelope;
  }
  if (discriminant.method !== undefined) {
    const notification = yield* Schema.decodeUnknownEffect(Notification)(value);
    const envelope: CodexEnvelope = {
      type: "notification",
      method: notification.method,
      ...(notification.params !== undefined && { params: notification.params }),
    };
    return envelope;
  }
  const response = yield* Schema.decodeUnknownEffect(Response)(value);
  if (response.result === undefined && response.error === undefined)
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: Schema.Unknown }))(value);
  const envelope: CodexEnvelope = {
    type: "response",
    id: response.id,
    ...(response.result !== undefined && { result: response.result }),
    ...(response.error !== undefined && { error: response.error }),
  };
  return envelope;
});

export const InitializeResult = Schema.Struct({
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
});
export const ThreadStartResult = Schema.Struct({
  model: Id,
  cwd: Schema.String,
  serviceTier: Schema.Union([Schema.String, Schema.Null]),
  thread: Schema.Struct({ id: Id, sessionId: Schema.optional(Id) }),
});
export const TurnStartResult = Schema.Struct({
  turn: Schema.Struct({ id: Id, status: Schema.String }),
});
export const TurnSteerResult = Schema.Struct({ turnId: Id });
export const EmptyObject = Schema.Record(Schema.String, Schema.Unknown);

const TurnStarted = Schema.Struct({
  threadId: Id,
  turn: Schema.Struct({ id: Id, status: Schema.String }),
});
const FileChangeKind = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add") }),
  Schema.Struct({ type: Schema.Literal("delete") }),
  Schema.Struct({
    type: Schema.Literal("update"),
    move_path: Schema.Union([
      Schema.String.check(Schema.isMaxLength(MAX_FILE_CHANGE_PATH_CHARS)),
      Schema.Null,
    ]),
  }),
]);
const FileUpdateChange = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FILE_CHANGE_PATH_CHARS)),
  kind: FileChangeKind,
});
const FileChanges = Schema.Array(FileUpdateChange).check(Schema.isMaxLength(MAX_FILE_CHANGES));
const Item = Schema.Struct({
  id: Id,
  type: Method,
  text: Schema.optional(Text),
  command: Schema.optional(Text),
  server: Schema.optional(Method),
  tool: Schema.optional(Method),
  status: Schema.optional(Method),
  arguments: Schema.optional(Schema.Unknown),
  changes: Schema.optional(FileChanges),
});
const NativeItemEnvelope = Schema.Struct({
  threadId: Id,
  turnId: Id,
  item: Schema.Unknown,
});
const NativeItemDiscriminant = Schema.Struct({ type: Schema.optional(Schema.String) });
const CollabAgentState = Schema.Struct({
  status: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  message: Schema.NullOr(Text),
});
const CollabAgentItem = Schema.Struct({
  id: Id,
  type: Schema.Literal("collabAgentToolCall"),
  tool: Schema.Literals(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"] as const),
  status: Schema.Literals(["inProgress", "completed", "failed"] as const),
  senderThreadId: Id,
  receiverThreadIds: Schema.Array(Id).check(Schema.isMaxLength(64)),
  prompt: Schema.NullOr(Text),
  model: Schema.NullOr(Text),
  reasoningEffort: Schema.NullOr(Text),
  agentsStates: Schema.Record(Schema.String, CollabAgentState),
});
const SubAgentActivityItem = Schema.Struct({
  id: Id,
  type: Schema.Literal("subAgentActivity"),
  kind: Schema.Literals(["started", "interacted", "interrupted"] as const),
  agentThreadId: Id,
  agentPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
const exactDecodeOptions = { onExcessProperty: "error" as const };
const AgentDelta = Schema.Struct({ threadId: Id, turnId: Id, itemId: Id, delta: Text });
const UsageBreakdown = Schema.Struct({
  inputTokens: Count,
  cachedInputTokens: Count,
  outputTokens: Count,
  reasoningOutputTokens: Count,
  totalTokens: Count,
  cacheWriteInputTokens: Schema.optional(Count),
});
const TokenUsage = Schema.Struct({
  threadId: Id,
  turnId: Id,
  tokenUsage: Schema.Struct({ total: UsageBreakdown, last: UsageBreakdown }),
});
const TurnCompleted = Schema.Struct({
  threadId: Id,
  turn: Schema.Struct({
    id: Id,
    status: Schema.String,
    error: Schema.optional(
      Schema.Union([
        Schema.Null,
        Schema.Struct({ message: Text, additionalDetails: Schema.optional(Schema.Unknown) }),
      ]),
    ),
  }),
});
const Warning = Schema.Struct({ message: Text });
const SummaryWarning = Schema.Struct({
  summary: Text,
  details: Schema.Union([Schema.Null, Text]),
});
const ErrorNotification = Schema.Struct({
  error: Schema.Struct({ message: Text }),
  willRetry: Schema.optional(Schema.Boolean),
  threadId: Schema.optional(Id),
  turnId: Schema.optional(Id),
});

export type CodexNotification =
  | { readonly type: "turn_started"; readonly threadId: string; readonly turnId: string }
  | {
      readonly type: "item_started" | "item_completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly item: Schema.Schema.Type<typeof Item>;
    }
  | {
      readonly type: "agent_delta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly type: "usage";
      readonly threadId: string;
      readonly turnId: string;
      readonly total: Schema.Schema.Type<typeof UsageBreakdown>;
    }
  | {
      readonly type: "turn_completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: string;
      readonly diagnostic?: string | undefined;
    }
  | {
      readonly type: "native_activity";
      readonly threadId: string;
      readonly turnId: string;
      readonly activityId: string;
      readonly kind: string;
      readonly state: "running" | "activity" | "failed" | "stopped";
    }
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "ignored" };

const normalizedWarning = (summary: string, details?: string | null): string => {
  const parts = [summary.trim(), details?.trim()]
    .filter((part): part is string => Boolean(part))
    .filter((part, index, values) => index === 0 || part !== values[0]);
  return (parts.join("\n") || "Codex warning.").slice(0, MAX_WARNING_TEXT_CHARS);
};

/** Bounded item started/completed decoding: native-agent discriminants first, then ordinary items. */
const decodeCodexItemNotification = Effect.fn("LocalCodexProtocol.decodeItemNotification")(
  function* <ParamsInput>(method: "item/started" | "item/completed", params: ParamsInput) {
    const envelope = yield* Schema.decodeUnknownEffect(NativeItemEnvelope)(params);
    const discriminant = yield* Schema.decodeUnknownEffect(NativeItemDiscriminant)(envelope.item);
    if (discriminant.type === "collabAgentToolCall") {
      const item = yield* Schema.decodeUnknownEffect(
        CollabAgentItem,
        exactDecodeOptions,
      )(envelope.item);
      const receiver = item.receiverThreadIds[0];
      const state =
        method === "item/started" || item.status === "inProgress"
          ? ("activity" as const)
          : item.status === "failed"
            ? ("failed" as const)
            : item.tool === "spawnAgent" && receiver
              ? ("running" as const)
              : item.tool === "closeAgent" && receiver
                ? ("stopped" as const)
                : ("activity" as const);
      return {
        type: "native_activity" as const,
        threadId: envelope.threadId,
        turnId: envelope.turnId,
        activityId: receiver ?? item.id,
        kind: item.tool,
        state,
      };
    }
    if (discriminant.type === "subAgentActivity") {
      const item = yield* Schema.decodeUnknownEffect(
        SubAgentActivityItem,
        exactDecodeOptions,
      )(envelope.item);
      if (method === "item/started") return { type: "ignored" as const };
      return {
        type: "native_activity" as const,
        threadId: envelope.threadId,
        turnId: envelope.turnId,
        activityId: item.agentThreadId,
        kind: `${item.kind}:${item.agentPath}`,
        state:
          item.kind === "started"
            ? ("running" as const)
            : item.kind === "interrupted"
              ? ("stopped" as const)
              : ("activity" as const),
      };
    }
    return {
      type: method === "item/started" ? ("item_started" as const) : ("item_completed" as const),
      threadId: envelope.threadId,
      turnId: envelope.turnId,
      item: yield* Schema.decodeUnknownEffect(Item)(envelope.item),
    };
  },
);

export const decodeCodexNotification = Effect.fn("LocalCodexProtocol.decodeNotification")(
  function* <ParamsInput>(method: string, params: ParamsInput) {
    switch (method) {
      case "turn/started": {
        const value = yield* Schema.decodeUnknownEffect(TurnStarted)(params);
        return {
          type: "turn_started" as const,
          threadId: value.threadId,
          turnId: value.turn.id,
        };
      }
      case "item/started":
      case "item/completed":
        return yield* decodeCodexItemNotification(method, params);
      case "item/agentMessage/delta": {
        const value = yield* Schema.decodeUnknownEffect(AgentDelta)(params);
        return { type: "agent_delta" as const, ...value };
      }
      case "thread/tokenUsage/updated": {
        const value = yield* Schema.decodeUnknownEffect(TokenUsage)(params);
        return {
          type: "usage" as const,
          threadId: value.threadId,
          turnId: value.turnId,
          total: value.tokenUsage.total,
        };
      }
      case "turn/completed": {
        const value = yield* Schema.decodeUnknownEffect(TurnCompleted)(params);
        const notification: CodexNotification = {
          type: "turn_completed",
          threadId: value.threadId,
          turnId: value.turn.id,
          status: value.turn.status,
          ...(value.turn.error &&
            hasObjectRuntimeType(value.turn.error) && { diagnostic: value.turn.error.message }),
        };
        return notification;
      }
      case "warning": {
        const value = yield* Schema.decodeUnknownEffect(Warning)(params);
        return { type: "warning" as const, message: normalizedWarning(value.message) };
      }
      case "configWarning":
      case "deprecationNotice": {
        const value = yield* Schema.decodeUnknownEffect(SummaryWarning)(params);
        return {
          type: "warning" as const,
          message: normalizedWarning(value.summary, value.details),
        };
      }
      case "error": {
        const value = yield* Schema.decodeUnknownEffect(ErrorNotification)(params);
        return {
          type: "warning" as const,
          message: value.willRetry
            ? `Codex transient error: ${value.error.message}`
            : `Codex error: ${value.error.message}`,
        };
      }
      default:
        return { type: "ignored" as const };
    }
  },
);

export type CodexInitializeRequest = ReturnType<typeof initializeRequest>;
export type CodexInitializedNotification = ReturnType<typeof initializedNotification>;
export type CodexThreadStartRequest = ReturnType<typeof threadStartRequest>;
export type CodexTurnStartRequest = ReturnType<typeof turnStartRequest>;
export type CodexTurnSteerRequest = ReturnType<typeof turnSteerRequest>;
export type CodexTurnInterruptRequest = ReturnType<typeof turnInterruptRequest>;

export interface CodexTextInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}

export type CodexRequest =
  | CodexInitializeRequest
  | CodexThreadStartRequest
  | CodexTurnStartRequest
  | CodexTurnSteerRequest
  | CodexTurnInterruptRequest;

export const initializeRequest = (id: string) =>
  ({
    id,
    method: "initialize",
    params: {
      clientInfo: { name: "pi-subagents", title: "pi-subagents", version: "1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  }) as const;

export const initializedNotification = () => ({ method: "initialized" }) as const;

export const threadStartRequest = (
  id: string,
  request: {
    readonly cwd: string;
    readonly model: string;
    readonly systemPrompt: string;
    readonly writeIntent: "read-only" | "writer";
    readonly openaiFastMode: boolean;
  },
) =>
  ({
    id,
    method: "thread/start",
    params: {
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      baseInstructions: request.systemPrompt,
      cwd: request.cwd,
      dynamicTools: [],
      environments: [],
      ephemeral: true,
      experimentalRawEvents: false,
      model: request.model,
      multiAgentMode: "explicitRequestOnly",
      sandbox: request.writeIntent === "writer" ? "workspace-write" : "read-only",
      ...(request.openaiFastMode && ({ serviceTier: FAST_SERVICE_TIER } as const)),
    },
  }) as const;

const input = (text: string): ReadonlyArray<CodexTextInput> => [
  { type: "text", text, text_elements: [] },
];

export const turnStartRequest = (
  id: string,
  threadId: string,
  text: string,
  model: string,
  effort: string,
  writeIntent: "read-only" | "writer",
  openaiFastMode: boolean,
) =>
  ({
    id,
    method: "turn/start",
    params: {
      threadId,
      input: input(text),
      approvalPolicy: "never",
      cwd: undefined,
      effort,
      environments: [],
      model,
      multiAgentMode: "explicitRequestOnly",
      sandboxPolicy:
        writeIntent === "writer"
          ? ({ type: "workspaceWrite", writableRoots: [], networkAccess: false } as const)
          : ({ type: "readOnly", networkAccess: false } as const),
      ...(openaiFastMode && ({ serviceTier: FAST_SERVICE_TIER } as const)),
    },
  }) as const;

export const turnSteerRequest = (id: string, threadId: string, turnId: string, text: string) =>
  ({
    id,
    method: "turn/steer",
    params: { threadId, expectedTurnId: turnId, input: input(text) },
  }) as const;

export const turnInterruptRequest = (id: string, threadId: string, turnId: string) =>
  ({
    id,
    method: "turn/interrupt",
    params: { threadId, turnId },
  }) as const;
