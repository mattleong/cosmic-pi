import { hasObjectRuntimeType } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SUBAGENT_FAST_SERVICE_TIER } from "../run/fast-mode.ts";

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
    const envelope: CodexEnvelope = (() => {
      const baseResult = { type: "notification" as const, method: notification.method };
      const withParams =
        notification.params === undefined
          ? baseResult
          : { ...baseResult, params: notification.params };
      return withParams;
    })();
    return envelope;
  }
  const response = yield* Schema.decodeUnknownEffect(Response)(value);
  if (response.result === undefined && response.error === undefined)
    yield* Schema.decodeUnknownEffect(Schema.Struct({ result: Schema.Unknown }))(value);
  const envelope: CodexEnvelope = (() => {
    const baseResult = { type: "response" as const, id: response.id };
    const withResult =
      response.result === undefined ? baseResult : { ...baseResult, result: response.result };
    const withError =
      response.error === undefined ? withResult : { ...withResult, error: response.error };
    return withError;
  })();
  return envelope;
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
  serviceTier: Schema.Union([Schema.String, Schema.Null]),
  thread: Schema.Struct({ id: Id, sessionId: Schema.optional(Id) }),
});
const TurnStartResult = Schema.Struct({
  turn: Schema.Struct({ id: Id, status: Schema.String }),
});
const TurnSteerResult = Schema.Struct({ turnId: Id });
const EmptyObject = Schema.Record(Schema.String, Schema.Unknown);

export const decodeInitializeResult = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(InitializeResult)(value);
export const decodeThreadStartResult = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(ThreadStartResult)(value);
export const decodeTurnStartResult = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(TurnStartResult)(value);
export const decodeTurnSteerResult = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(TurnSteerResult)(value);
export const decodeEmptyResult = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(EmptyObject)(value);

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
        const notification: CodexNotification = (() => {
          const baseResult = {
            type: "turn_completed" as const,
            threadId: value.threadId,
            turnId: value.turn.id,
            status: value.turn.status,
          };
          const withDiagnostic =
            value.turn.error && hasObjectRuntimeType(value.turn.error)
              ? { ...baseResult, diagnostic: value.turn.error.message }
              : baseResult;
          return withDiagnostic;
        })();
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

export interface CodexInitializeRequest {
  readonly id: string;
  readonly method: "initialize";
  readonly params: {
    readonly clientInfo: {
      readonly name: "pi-subagents";
      readonly title: "pi-subagents";
      readonly version: "1";
    };
    readonly capabilities: {
      readonly experimentalApi: true;
      readonly optOutNotificationMethods: ReadonlyArray<string>;
    };
  };
}

export interface CodexInitializedNotification {
  readonly method: "initialized";
}

export interface CodexThreadStartRequest {
  readonly id: string;
  readonly method: "thread/start";
  readonly params: {
    readonly allowProviderModelFallback: false;
    readonly approvalPolicy: "never";
    readonly baseInstructions: string;
    readonly cwd: string;
    readonly dynamicTools: ReadonlyArray<never>;
    readonly environments: ReadonlyArray<never>;
    readonly ephemeral: true;
    readonly experimentalRawEvents: false;
    readonly model: string;
    readonly serviceTier?: typeof SUBAGENT_FAST_SERVICE_TIER | undefined;
    readonly multiAgentMode: "explicitRequestOnly";
    readonly sandbox: "workspace-write" | "read-only";
  };
}

export interface CodexTextInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}

export interface CodexTurnStartRequest {
  readonly id: string;
  readonly method: "turn/start";
  readonly params: {
    readonly threadId: string;
    readonly input: ReadonlyArray<CodexTextInput>;
    readonly approvalPolicy: "never";
    readonly cwd: undefined;
    readonly effort: string;
    readonly environments: ReadonlyArray<never>;
    readonly model: string;
    readonly serviceTier?: typeof SUBAGENT_FAST_SERVICE_TIER | undefined;
    readonly multiAgentMode: "explicitRequestOnly";
    readonly sandboxPolicy:
      | {
          readonly type: "workspaceWrite";
          readonly writableRoots: ReadonlyArray<never>;
          readonly networkAccess: false;
        }
      | { readonly type: "readOnly"; readonly networkAccess: false };
  };
}

export interface CodexTurnSteerRequest {
  readonly id: string;
  readonly method: "turn/steer";
  readonly params: {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly input: ReadonlyArray<CodexTextInput>;
  };
}

export interface CodexTurnInterruptRequest {
  readonly id: string;
  readonly method: "turn/interrupt";
  readonly params: { readonly threadId: string; readonly turnId: string };
}

export type CodexRequest =
  | CodexInitializeRequest
  | CodexThreadStartRequest
  | CodexTurnStartRequest
  | CodexTurnSteerRequest
  | CodexTurnInterruptRequest;

export const initializeRequest = (id: string): CodexInitializeRequest => ({
  id,
  method: "initialize",
  params: {
    clientInfo: { name: "pi-subagents", title: "pi-subagents", version: "1" },
    capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
  },
});

export const initializedNotification = (): CodexInitializedNotification => ({
  method: "initialized",
});

export const threadStartRequest = (
  id: string,
  request: {
    readonly cwd: string;
    readonly model: string;
    readonly systemPrompt: string;
    readonly writeIntent: "read-only" | "writer";
    readonly fastMode: boolean;
  },
): CodexThreadStartRequest => {
  const base: CodexThreadStartRequest["params"] = {
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
  };
  const params: CodexThreadStartRequest["params"] = request.fastMode
    ? { ...base, serviceTier: SUBAGENT_FAST_SERVICE_TIER }
    : base;
  return { id, method: "thread/start", params };
};

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
  fastMode: boolean,
): CodexTurnStartRequest => {
  const base: CodexTurnStartRequest["params"] = {
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
  };
  const params: CodexTurnStartRequest["params"] = fastMode
    ? { ...base, serviceTier: SUBAGENT_FAST_SERVICE_TIER }
    : base;
  return { id, method: "turn/start", params };
};

export const turnSteerRequest = (
  id: string,
  threadId: string,
  turnId: string,
  text: string,
): CodexTurnSteerRequest => ({
  id,
  method: "turn/steer",
  params: { threadId, expectedTurnId: turnId, input: input(text) },
});

export const turnInterruptRequest = (
  id: string,
  threadId: string,
  turnId: string,
): CodexTurnInterruptRequest => ({
  id,
  method: "turn/interrupt",
  params: { threadId, turnId },
});
