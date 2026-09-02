import * as Predicate from "effect/Predicate";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SubagentUsage } from "../run/model.ts";

const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 1024 * 1024;
const INTERRUPT_MARKER = "[Request interrupted by user]";
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ID_CHARS));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NAME_CHARS));
const Text = Schema.String.check(Schema.isMaxLength(MAX_TEXT_CHARS));
const Token = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Text });
const ToolUsePart = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Id,
  name: Name,
  input: Schema.optional(Schema.Unknown),
});
const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Id,
  is_error: Schema.optional(Schema.Boolean),
});
const Usage = Schema.Struct({
  input_tokens: Schema.optional(Token),
  output_tokens: Schema.optional(Token),
  cache_read_input_tokens: Schema.optional(Token),
  cache_creation_input_tokens: Schema.optional(Token),
});
const Cost = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const MessageOrigin = Schema.Struct({
  kind: Name,
  subkind: Schema.optional(Name),
});
const ParentToolUseId = Schema.Union([Schema.Null, Id]);
const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  session_id: Schema.optional(Id),
  parent_tool_use_id: Schema.optional(ParentToolUseId),
  message: Schema.Struct({
    id: Schema.optional(Id),
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Unknown),
    usage: Schema.optional(Usage),
  }),
});
const User = Schema.Struct({
  type: Schema.Literal("user"),
  uuid: Schema.optional(Id),
  session_id: Schema.optional(Id),
  parent_tool_use_id: Schema.optional(ParentToolUseId),
  isSynthetic: Schema.optional(Schema.Boolean),
  isReplay: Schema.optional(Schema.Boolean),
  origin: Schema.optional(MessageOrigin),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Text, Schema.Array(Schema.Unknown)]),
  }),
});
const SystemInit = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  cwd: Text,
  session_id: Id,
  model: Name,
  tools: Schema.Array(Name),
  mcp_servers: Schema.Array(
    Schema.Struct({
      name: Name,
      status: Name,
    }),
  ),
  mcp_server_errors: Schema.optional(Schema.Array(Schema.Unknown)),
});
const SystemEvent = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.optional(Schema.String),
});
const StreamEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.optional(Schema.Unknown),
});
const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.optional(Name),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Text),
  errors: Schema.optional(Schema.Array(Text)),
  stop_reason: Schema.optional(Schema.Union([Schema.Null, Name])),
  session_id: Schema.optional(Id),
  /** UUID of the user message whose query produced this result, when reported. */
  user_message_uuid: Schema.optional(Id),
  origin: Schema.optional(MessageOrigin),
  usage: Schema.optional(Usage),
  total_cost_usd: Schema.optional(Cost),
});
const ControlResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  request_id: Schema.optional(Id),
  response: Schema.optional(
    Schema.Struct({
      subtype: Schema.optional(Name),
      request_id: Schema.optional(Id),
      error: Schema.optional(Text),
      response: Schema.optional(Schema.Unknown),
    }),
  ),
});
const InitializeControlResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      value: Name,
      resolvedModel: Name,
    }),
  ),
});
const McpStatusControlResponse = Schema.Struct({
  mcpServers: Schema.Array(
    Schema.Struct({
      name: Name,
      status: Name,
      tools: Schema.optional(Schema.Array(Schema.Struct({ name: Name }))),
    }),
  ),
});
const Discriminant = Schema.Struct({ type: Schema.optional(Schema.String) });

export type ClaudeInboundFrame =
  | typeof Assistant.Type
  | typeof User.Type
  | typeof SystemInit.Type
  | typeof SystemEvent.Type
  | typeof StreamEvent.Type
  | typeof Result.Type
  | typeof ControlResponse.Type;

export type ClaudeProtocolEvent =
  | {
      readonly type: "init";
      readonly cwd: string;
      readonly sessionId: string;
      readonly model: string;
      readonly tools: ReadonlyArray<string>;
      readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
      readonly hasMcpServerErrors: boolean;
    }
  | {
      readonly type: "user";
      readonly text: string;
      readonly toolResults: ReadonlyArray<{ readonly id: string; readonly isError: boolean }>;
      readonly uuid?: string | undefined;
      readonly sessionId?: string | undefined;
      readonly parentToolUseId?: string | undefined;
      readonly originKind?: string | undefined;
      readonly originSubkind?: string | undefined;
      readonly isSynthetic: boolean;
      readonly isReplay: boolean;
    }
  | {
      readonly type: "assistant";
      readonly text?: string | undefined;
      readonly messageId?: string | undefined;
      readonly parentToolUseId?: string | undefined;
      readonly tools: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }>;
      /** As-reported cumulative usage for this native message; the adapter deduplicates. */
      readonly usage: SubagentUsage;
    }
  | { readonly type: "activity" }
  | {
      readonly type: "result";
      readonly isError: boolean;
      readonly subtype?: string | undefined;
      readonly stopReason?: string | undefined;
      readonly sessionId?: string | undefined;
      readonly userMessageUuid?: string | undefined;
      readonly originKind?: string | undefined;
      readonly originSubkind?: string | undefined;
      /** As-reported cumulative usage for the whole query, when present. */
      readonly usage?: SubagentUsage | undefined;
      /** Known cumulative client-side cost estimate in USD, when present. */
      readonly totalCostUsd?: number | undefined;
      readonly diagnostic?: string | undefined;
    }
  | {
      readonly type: "control_response";
      readonly requestId: string;
      readonly success: boolean;
      readonly diagnostic?: string | undefined;
      readonly response?: unknown;
    }
  | { readonly type: "ignored" };

export interface ClaudeNativeInitialization {
  readonly cwd: string;
  readonly sessionId: string;
  readonly model: string;
  readonly tools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly hasMcpServerErrors: boolean;
}

export const CLAUDE_INTERRUPT_MARKER = INTERRUPT_MARKER;

const textFromContent = (content: string | ReadonlyArray<unknown>): string =>
  Predicate.isString(content)
    ? content
    : content
        .flatMap((part) => {
          const decoded = Schema.decodeUnknownOption(TextPart)(part);
          return decoded._tag === "Some" ? [decoded.value.text] : [];
        })
        .join("\n");

/** Chosen total-token definition: input + output + cache-read + cache-write. */
const usageFromNative = (usage: Schema.Schema.Type<typeof Usage> | undefined): SubagentUsage => {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
};

export const decodeClaudeProtocolEvent = <ValueInput>(
  value: ValueInput,
): Effect.Effect<ClaudeProtocolEvent, Schema.SchemaError> =>
  Effect.gen(function* () {
    const discriminant = yield* Schema.decodeUnknownEffect(Discriminant)(value);
    switch (discriminant.type) {
      case "system": {
        const system = yield* Schema.decodeUnknownEffect(SystemEvent)(value);
        if (system.subtype === "status") return { type: "activity" };
        if (system.subtype !== "init") return { type: "ignored" };
        const event = yield* Schema.decodeUnknownEffect(SystemInit)(value);
        return {
          type: "init",
          cwd: event.cwd,
          sessionId: event.session_id,
          model: event.model,
          tools: event.tools,
          mcpServers: event.mcp_servers,
          hasMcpServerErrors: (event.mcp_server_errors?.length ?? 0) > 0,
        };
      }
      case "user": {
        const event = yield* Schema.decodeUnknownEffect(User)(value);
        const toolResults = Predicate.isString(event.message.content)
          ? []
          : event.message.content.flatMap((part) => {
              const decoded = Schema.decodeUnknownOption(ToolResultPart)(part);
              return decoded._tag === "Some"
                ? [{ id: decoded.value.tool_use_id, isError: decoded.value.is_error === true }]
                : [];
            });
        const protocolEvent: ClaudeProtocolEvent = (() => {
          const baseResult = {
            type: "user" as const,
            text: textFromContent(event.message.content),
            toolResults,
          };
          const withUuid = event.uuid ? { ...baseResult, uuid: event.uuid } : baseResult;
          const withSessionId = event.session_id
            ? { ...withUuid, sessionId: event.session_id }
            : withUuid;
          const withParentToolUseId = event.parent_tool_use_id
            ? { ...withSessionId, parentToolUseId: event.parent_tool_use_id }
            : withSessionId;
          const withOriginKind = event.origin
            ? { ...withParentToolUseId, originKind: event.origin.kind }
            : withParentToolUseId;
          const withOriginSubkind = event.origin?.subkind
            ? { ...withOriginKind, originSubkind: event.origin.subkind }
            : withOriginKind;
          const withIsSyntheticAndIsReplay = {
            ...withOriginSubkind,
            isSynthetic: event.isSynthetic === true,
            isReplay: event.isReplay === true,
          };
          return withIsSyntheticAndIsReplay;
        })();
        return protocolEvent;
      }
      case "assistant": {
        const event = yield* Schema.decodeUnknownEffect(Assistant)(value);
        const tools = event.message.content.flatMap((part) => {
          const decoded = Schema.decodeUnknownOption(ToolUsePart)(part);
          return decoded._tag === "Some"
            ? [{ id: decoded.value.id, name: decoded.value.name, input: decoded.value.input }]
            : [];
        });
        const text = textFromContent(event.message.content).trim();
        const protocolEvent: ClaudeProtocolEvent = (() => {
          const baseResult = { type: "assistant" as const };
          const withText = text ? { ...baseResult, text } : baseResult;
          const withMessageId = event.message.id
            ? { ...withText, messageId: event.message.id }
            : withText;
          const withParentToolUseId = event.parent_tool_use_id
            ? { ...withMessageId, parentToolUseId: event.parent_tool_use_id }
            : withMessageId;
          const withToolsAndUsage = {
            ...withParentToolUseId,
            tools,
            usage: usageFromNative(event.message.usage),
          };
          return withToolsAndUsage;
        })();
        return protocolEvent;
      }
      case "stream_event":
        yield* Schema.decodeUnknownEffect(StreamEvent)(value);
        return { type: "activity" };
      case "result": {
        const event = yield* Schema.decodeUnknownEffect(Result)(value);
        const diagnostic =
          event.result?.trim() ||
          event.errors
            ?.map((error) => error.trim())
            .filter(Boolean)
            .join("\n");
        const protocolEvent: ClaudeProtocolEvent = (() => {
          const baseResult = { type: "result" as const, isError: event.is_error === true };
          const withSubtype = event.subtype
            ? { ...baseResult, subtype: event.subtype }
            : baseResult;
          const withStopReason = event.stop_reason
            ? { ...withSubtype, stopReason: event.stop_reason }
            : withSubtype;
          const withSessionId = event.session_id
            ? { ...withStopReason, sessionId: event.session_id }
            : withStopReason;
          const withUserMessageUuid = event.user_message_uuid
            ? { ...withSessionId, userMessageUuid: event.user_message_uuid }
            : withSessionId;
          const withOriginKind = event.origin
            ? { ...withUserMessageUuid, originKind: event.origin.kind }
            : withUserMessageUuid;
          const withOriginSubkind = event.origin?.subkind
            ? { ...withOriginKind, originSubkind: event.origin.subkind }
            : withOriginKind;
          const withUsage = event.usage
            ? { ...withOriginSubkind, usage: usageFromNative(event.usage) }
            : withOriginSubkind;
          const withTotalCostUsd =
            event.total_cost_usd === undefined
              ? withUsage
              : { ...withUsage, totalCostUsd: event.total_cost_usd };
          const withDiagnostic = diagnostic
            ? { ...withTotalCostUsd, diagnostic }
            : withTotalCostUsd;
          return withDiagnostic;
        })();
        return protocolEvent;
      }
      case "control_response": {
        const event = yield* Schema.decodeUnknownEffect(ControlResponse)(value);
        const requestId = event.request_id ?? event.response?.request_id;
        if (!requestId) {
          yield* Schema.decodeUnknownEffect(Schema.Struct({ request_id: Id }))(value);
          return { type: "ignored" } as const;
        }
        const success = event.response?.subtype === "success";
        const protocolEvent: ClaudeProtocolEvent = (() => {
          const baseResult = { type: "control_response" as const, requestId, success };
          const withDiagnostic = event.response?.error
            ? { ...baseResult, diagnostic: event.response.error }
            : baseResult;
          const withResponse =
            event.response?.response === undefined
              ? withDiagnostic
              : { ...withDiagnostic, response: event.response.response };
          return withResponse;
        })();
        return protocolEvent;
      }
      default:
        return { type: "ignored" };
    }
  });

export const decodeClaudeInitializeControlResponse = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(InitializeControlResponse)(value);

export const decodeClaudeMcpStatusControlResponse = <ValueInput>(value: ValueInput) =>
  Schema.decodeUnknownEffect(McpStatusControlResponse)(value);

export interface ClaudeUserFrame {
  readonly type: "user";
  readonly uuid?: string | undefined;
  readonly message: { readonly role: "user"; readonly content: string };
  readonly shouldQuery?: boolean | undefined;
}

export interface ClaudeInitializeFrame {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request: { readonly subtype: "initialize" };
}

export interface ClaudeMcpStatusFrame {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request: { readonly subtype: "mcp_status" };
}

export interface ClaudeInterruptFrame {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request: { readonly subtype: "interrupt"; readonly cancel_queued: true };
}

export type ClaudeControlRequestFrame =
  | ClaudeInitializeFrame
  | ClaudeMcpStatusFrame
  | ClaudeInterruptFrame;

export const claudeUserFrame = (
  message: string,
  options: { readonly shouldQuery?: boolean | undefined; readonly uuid?: string | undefined } = {},
): ClaudeUserFrame => {
  const frame: ClaudeUserFrame = (() => {
    const baseResult = { type: "user" as const };
    const withUuid = options.uuid ? { ...baseResult, uuid: options.uuid } : baseResult;
    const withMessage = {
      ...withUuid,
      message: { role: "user" as const, content: message },
    };
    const withShouldQuery =
      options.shouldQuery === undefined
        ? withMessage
        : { ...withMessage, shouldQuery: options.shouldQuery };
    return withShouldQuery;
  })();
  return frame;
};

export const claudeInitializeFrame = (requestId: string): ClaudeInitializeFrame => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "initialize" },
});

export const claudeMcpStatusFrame = (requestId: string): ClaudeMcpStatusFrame => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "mcp_status" },
});

export const claudeInterruptFrame = (requestId: string): ClaudeInterruptFrame => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "interrupt", cancel_queued: true },
});
