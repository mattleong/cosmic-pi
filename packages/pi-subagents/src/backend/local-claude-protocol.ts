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
const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  session_id: Schema.optional(Id),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Unknown),
    usage: Schema.optional(Usage),
  }),
});
const User = Schema.Struct({
  type: Schema.Literal("user"),
  session_id: Schema.optional(Id),
  isSynthetic: Schema.optional(Schema.Boolean),
  isReplay: Schema.optional(Schema.Boolean),
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
      readonly isSynthetic: boolean;
      readonly isReplay: boolean;
    }
  | {
      readonly type: "assistant";
      readonly text?: string | undefined;
      readonly tools: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }>;
      readonly usage: SubagentUsage;
    }
  | { readonly type: "activity" }
  | {
      readonly type: "result";
      readonly isError: boolean;
      readonly subtype?: string | undefined;
      readonly stopReason?: string | undefined;
      readonly sessionId?: string | undefined;
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
  typeof content === "string"
    ? content
    : content
        .flatMap((part) => {
          const decoded = Schema.decodeUnknownOption(TextPart)(part);
          return decoded._tag === "Some" ? [decoded.value.text] : [];
        })
        .join("\n");

const zeroUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

export const decodeClaudeProtocolEvent = (
  value: unknown,
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
        const toolResults =
          typeof event.message.content === "string"
            ? []
            : event.message.content.flatMap((part) => {
                const decoded = Schema.decodeUnknownOption(ToolResultPart)(part);
                return decoded._tag === "Some"
                  ? [{ id: decoded.value.tool_use_id, isError: decoded.value.is_error === true }]
                  : [];
              });
        return {
          type: "user",
          text: textFromContent(event.message.content),
          toolResults,
          isSynthetic: event.isSynthetic === true,
          isReplay: event.isReplay === true,
        };
      }
      case "assistant": {
        const event = yield* Schema.decodeUnknownEffect(Assistant)(value);
        const usage = event.message.usage;
        const normalized = zeroUsage();
        const input = usage?.input_tokens ?? 0;
        const output = usage?.output_tokens ?? 0;
        const cacheRead = usage?.cache_read_input_tokens ?? 0;
        const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
        const tools = event.message.content.flatMap((part) => {
          const decoded = Schema.decodeUnknownOption(ToolUsePart)(part);
          return decoded._tag === "Some"
            ? [{ id: decoded.value.id, name: decoded.value.name, input: decoded.value.input }]
            : [];
        });
        const text = textFromContent(event.message.content).trim();
        return {
          type: "assistant",
          ...(text ? { text } : {}),
          tools,
          usage: {
            ...normalized,
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens: input + output,
          },
        };
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
        return {
          type: "result",
          isError: event.is_error === true,
          ...(event.subtype ? { subtype: event.subtype } : {}),
          ...(event.stop_reason ? { stopReason: event.stop_reason } : {}),
          ...(event.session_id ? { sessionId: event.session_id } : {}),
          ...(diagnostic ? { diagnostic } : {}),
        };
      }
      case "control_response": {
        const event = yield* Schema.decodeUnknownEffect(ControlResponse)(value);
        const requestId = event.request_id ?? event.response?.request_id;
        if (!requestId) {
          yield* Schema.decodeUnknownEffect(Schema.Struct({ request_id: Id }))(value);
          return { type: "ignored" } as const;
        }
        const success = event.response?.subtype === "success";
        return {
          type: "control_response",
          requestId,
          success,
          ...(event.response?.error ? { diagnostic: event.response.error } : {}),
          ...(event.response?.response === undefined ? {} : { response: event.response.response }),
        };
      }
      default:
        return { type: "ignored" };
    }
  });

export const decodeClaudeInitializeControlResponse = (value: unknown) =>
  Schema.decodeUnknownEffect(InitializeControlResponse)(value);

export const decodeClaudeMcpStatusControlResponse = (value: unknown) =>
  Schema.decodeUnknownEffect(McpStatusControlResponse)(value);

export const claudeUserFrame = (
  message: string,
  options: { readonly shouldQuery?: boolean | undefined } = {},
): Readonly<Record<string, unknown>> => ({
  type: "user",
  message: { role: "user", content: message },
  ...(options.shouldQuery === undefined ? {} : { shouldQuery: options.shouldQuery }),
});

export const claudeInitializeFrame = (requestId: string): Readonly<Record<string, unknown>> => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "initialize" },
});

export const claudeMcpStatusFrame = (requestId: string): Readonly<Record<string, unknown>> => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "mcp_status" },
});

export const claudeInterruptFrame = (requestId: string): Readonly<Record<string, unknown>> => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "interrupt", cancel_queued: true },
});
