import { isStringValue } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SubagentUsage } from "../run/model.ts";

const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 1024 * 1024;
const INTERRUPT_MARKER = "[Request interrupted by user]";
const SUPERVISOR_SERVER = "pi_subagents_supervisor";
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
const MessageOrigin = Schema.Struct({ kind: Name });
const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  session_id: Schema.optional(Id),
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
      readonly originKind?: string | undefined;
      readonly isSynthetic: boolean;
      readonly isReplay: boolean;
    }
  | {
      readonly type: "assistant";
      readonly text?: string | undefined;
      readonly messageId?: string | undefined;
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
export const CLAUDE_SUPERVISOR_SERVER_NAME = SUPERVISOR_SERVER;
export const CLAUDE_SUPERVISOR_TOOL_NAMES = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
  "supervisor_submit_report",
] as const;

const textFromContent = (content: string | ReadonlyArray<unknown>): string =>
  isStringValue(content)
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
        const toolResults = isStringValue(event.message.content)
          ? []
          : event.message.content.flatMap((part) => {
              const decoded = Schema.decodeUnknownOption(ToolResultPart)(part);
              return decoded._tag === "Some"
                ? [{ id: decoded.value.tool_use_id, isError: decoded.value.is_error === true }]
                : [];
            });
        const protocolEvent: ClaudeProtocolEvent = (() => {
          const objectPart8981_0 = {
            type: "user" as const,
            text: textFromContent(event.message.content),
            toolResults,
          };
          const objectPart8981_1 = event.uuid
            ? { ...objectPart8981_0, uuid: event.uuid }
            : objectPart8981_0;
          const objectPart8981_2 = event.session_id
            ? { ...objectPart8981_1, sessionId: event.session_id }
            : objectPart8981_1;
          const objectPart8981_3 = event.origin
            ? { ...objectPart8981_2, originKind: event.origin.kind }
            : objectPart8981_2;
          const objectPart8981_4 = {
            ...objectPart8981_3,
            isSynthetic: event.isSynthetic === true,
            isReplay: event.isReplay === true,
          };
          return objectPart8981_4;
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
          const objectPart9885_0 = { type: "assistant" as const };
          const objectPart9885_1 = text ? { ...objectPart9885_0, text } : objectPart9885_0;
          const objectPart9885_2 = event.message.id
            ? { ...objectPart9885_1, messageId: event.message.id }
            : objectPart9885_1;
          const objectPart9885_3 = {
            ...objectPart9885_2,
            tools,
            usage: usageFromNative(event.message.usage),
          };
          return objectPart9885_3;
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
          const objectPart10534_0 = { type: "result" as const, isError: event.is_error === true };
          const objectPart10534_1 = event.subtype
            ? { ...objectPart10534_0, subtype: event.subtype }
            : objectPart10534_0;
          const objectPart10534_2 = event.stop_reason
            ? { ...objectPart10534_1, stopReason: event.stop_reason }
            : objectPart10534_1;
          const objectPart10534_3 = event.session_id
            ? { ...objectPart10534_2, sessionId: event.session_id }
            : objectPart10534_2;
          const objectPart10534_4 = event.user_message_uuid
            ? { ...objectPart10534_3, userMessageUuid: event.user_message_uuid }
            : objectPart10534_3;
          const objectPart10534_5 = event.origin
            ? { ...objectPart10534_4, originKind: event.origin.kind }
            : objectPart10534_4;
          const objectPart10534_6 = event.usage
            ? { ...objectPart10534_5, usage: usageFromNative(event.usage) }
            : objectPart10534_5;
          const objectPart10534_7 =
            event.total_cost_usd === undefined
              ? objectPart10534_6
              : { ...objectPart10534_6, totalCostUsd: event.total_cost_usd };
          const objectPart10534_8 = diagnostic
            ? { ...objectPart10534_7, diagnostic }
            : objectPart10534_7;
          return objectPart10534_8;
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
          const objectPart11655_0 = { type: "control_response" as const, requestId, success };
          const objectPart11655_1 = event.response?.error
            ? { ...objectPart11655_0, diagnostic: event.response.error }
            : objectPart11655_0;
          const objectPart11655_2 =
            event.response?.response === undefined
              ? objectPart11655_1
              : { ...objectPart11655_1, response: event.response.response };
          return objectPart11655_2;
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
    const objectPart13295_0 = { type: "user" as const };
    const objectPart13295_1 = options.uuid
      ? { ...objectPart13295_0, uuid: options.uuid }
      : objectPart13295_0;
    const objectPart13295_2 = {
      ...objectPart13295_1,
      message: { role: "user" as const, content: message },
    };
    const objectPart13295_3 =
      options.shouldQuery === undefined
        ? objectPart13295_2
        : { ...objectPart13295_2, shouldQuery: options.shouldQuery };
    return objectPart13295_3;
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
