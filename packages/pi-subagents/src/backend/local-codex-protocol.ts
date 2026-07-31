import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_ID_CHARS = 256;
const MAX_METHOD_CHARS = 128;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_WARNING_TEXT_CHARS = 16 * 1024;
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

export const decodeCodexEnvelope = Effect.fn("LocalCodexProtocol.decodeEnvelope")(function* (
  value: unknown,
) {
  const discriminant = yield* Schema.decodeUnknownEffect(EnvelopeDiscriminant)(value);
  if (discriminant.method !== undefined && discriminant.id !== undefined) {
    const request = yield* Schema.decodeUnknownEffect(ServerRequest)(value);
    return {
      type: "server_request" as const,
      id: request.id,
      method: request.method,
    };
  }
  if (discriminant.method !== undefined) {
    const notification = yield* Schema.decodeUnknownEffect(Notification)(value);
    return {
      type: "notification" as const,
      method: notification.method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    };
  }
  const response = yield* Schema.decodeUnknownEffect(Response)(value);
  if (response.result === undefined && response.error === undefined)
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: Schema.Unknown }))(value);
  return {
    type: "response" as const,
    id: response.id,
    ...(response.result === undefined ? {} : { result: response.result }),
    ...(response.error === undefined ? {} : { error: response.error }),
  };
});

const InitializeResult = Schema.Struct({
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
});
const ThreadStartResult = Schema.Struct({
  model: Id,
  cwd: Schema.String,
  thread: Schema.Struct({ id: Id, sessionId: Schema.optional(Id) }),
});
const TurnStartResult = Schema.Struct({
  turn: Schema.Struct({ id: Id, status: Schema.String }),
});
const TurnSteerResult = Schema.Struct({ turnId: Id });
const EmptyObject = Schema.Record(Schema.String, Schema.Unknown);

export const decodeInitializeResult = (value: unknown) =>
  Schema.decodeUnknownEffect(InitializeResult)(value);
export const decodeThreadStartResult = (value: unknown) =>
  Schema.decodeUnknownEffect(ThreadStartResult)(value);
export const decodeTurnStartResult = (value: unknown) =>
  Schema.decodeUnknownEffect(TurnStartResult)(value);
export const decodeTurnSteerResult = (value: unknown) =>
  Schema.decodeUnknownEffect(TurnSteerResult)(value);
export const decodeEmptyResult = (value: unknown) => Schema.decodeUnknownEffect(EmptyObject)(value);

const TurnStarted = Schema.Struct({
  threadId: Id,
  turn: Schema.Struct({ id: Id, status: Schema.String }),
});
const Item = Schema.Struct({
  id: Id,
  type: Method,
  text: Schema.optional(Text),
  command: Schema.optional(Text),
  server: Schema.optional(Method),
  tool: Schema.optional(Method),
  status: Schema.optional(Method),
  arguments: Schema.optional(Schema.Unknown),
});
const ItemStarted = Schema.Struct({ threadId: Id, turnId: Id, item: Item });
const ItemCompleted = Schema.Struct({ threadId: Id, turnId: Id, item: Item });
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
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "ignored" };

const normalizedWarning = (summary: string, details?: string | null): string => {
  const parts = [summary.trim(), details?.trim()]
    .filter((part): part is string => Boolean(part))
    .filter((part, index, values) => index === 0 || part !== values[0]);
  return (parts.join("\n") || "Codex warning.").slice(0, MAX_WARNING_TEXT_CHARS);
};

export const decodeCodexNotification = Effect.fn("LocalCodexProtocol.decodeNotification")(
  function* (method: string, params: unknown) {
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
      case "item/completed": {
        const schema = method === "item/started" ? ItemStarted : ItemCompleted;
        const value = yield* Schema.decodeUnknownEffect(schema)(params);
        return {
          type: method === "item/started" ? ("item_started" as const) : ("item_completed" as const),
          threadId: value.threadId,
          turnId: value.turnId,
          item: value.item,
        };
      }
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
        return {
          type: "turn_completed" as const,
          threadId: value.threadId,
          turnId: value.turn.id,
          status: value.turn.status,
          ...(value.turn.error && typeof value.turn.error === "object"
            ? { diagnostic: value.turn.error.message }
            : {}),
        };
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

export interface CodexRequest extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly method: "initialize" | "thread/start" | "turn/start" | "turn/steer" | "turn/interrupt";
  readonly params: Readonly<Record<string, unknown>>;
}

export const initializeRequest = (id: string): CodexRequest => ({
  id,
  method: "initialize",
  params: {
    clientInfo: { name: "pi-subagents", title: "pi-subagents", version: "1" },
    capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
  },
});

export const initializedNotification = (): Readonly<Record<string, unknown>> => ({
  method: "initialized",
});

export const threadStartRequest = (
  id: string,
  request: {
    readonly cwd: string;
    readonly model: string;
    readonly systemPrompt: string;
    readonly writeIntent: "read-only" | "writer";
  },
): CodexRequest => ({
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
  },
});

const input = (text: string) => [{ type: "text", text, text_elements: [] }];

export const turnStartRequest = (
  id: string,
  threadId: string,
  text: string,
  model: string,
  effort: string,
  writeIntent: "read-only" | "writer",
): CodexRequest => ({
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
        ? { type: "workspaceWrite", writableRoots: [], networkAccess: false }
        : { type: "readOnly", networkAccess: false },
  },
});

export const turnSteerRequest = (
  id: string,
  threadId: string,
  turnId: string,
  text: string,
): CodexRequest => ({
  id,
  method: "turn/steer",
  params: { threadId, expectedTurnId: turnId, input: input(text) },
});

export const turnInterruptRequest = (
  id: string,
  threadId: string,
  turnId: string,
): CodexRequest => ({
  id,
  method: "turn/interrupt",
  params: { threadId, turnId },
});
