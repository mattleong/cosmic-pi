import { toolOutputPreview } from "./tool-output-preview.ts";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import type { OversizedLine } from "../boundary/bounded-line-parser.ts";
import { jsonPrefixScalars } from "../boundary/json-prefix.ts";
import { omittedOutputPreview } from "./driver-shared.ts";
import type { SubagentUsage } from "../run/model.ts";
import type { UsageComponents } from "./local-claude-usage.ts";
import { CLAUDE_HOOK_REGISTRATIONS, claudeMainAgentToolDecision } from "./claude-policy.ts";

const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 1024 * 1024;
export const CLAUDE_INTERRUPT_MARKER = "[Request interrupted by user]";
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
  content: Schema.optional(Schema.Unknown),
});
const Usage = Schema.Struct({
  input_tokens: Schema.optional(Token),
  output_tokens: Schema.optional(Token),
  cache_read_input_tokens: Schema.optional(Token),
  cache_creation_input_tokens: Schema.optional(Token),
});
const Cost = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const MAX_RESULT_MODELS = 64;
// Per-model running totals for every query-pipeline call, including native agents and compaction.
const ModelUsage = Schema.Record(
  Name,
  Schema.Struct({
    inputTokens: Schema.optional(Token),
    outputTokens: Schema.optional(Token),
    cacheReadInputTokens: Schema.optional(Token),
    cacheCreationInputTokens: Schema.optional(Token),
  }),
).check(Schema.isMaxProperties(MAX_RESULT_MODELS));
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
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
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
  claude_code_version: Schema.optional(Name),
});
const SystemEvent = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.optional(Schema.String),
});
// Claude Code 2.1 ends a turn while background agents or shells run, then starts a new turn when
// their completion notification arrives; this event carries the live task list.
const BackgroundTasksChanged = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("background_tasks_changed"),
  tasks: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1_024)),
  session_id: Schema.optional(Id),
});
const BackgroundTaskId = Schema.Struct({ task_id: Id });
const isBackgroundTaskId = Schema.is(BackgroundTaskId);
const TaskNotification = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("task_notification"),
  task_id: Id,
  session_id: Schema.optional(Id),
});
const StreamEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.optional(Schema.Unknown),
});
const ResultEvent = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.optional(Name),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Text),
  errors: Schema.optional(Schema.Array(Text)),
  stop_reason: Schema.optional(Schema.Union([Schema.Null, Name])),
  session_id: Schema.optional(Id),
  user_message_uuid: Schema.optional(Id),
  origin: Schema.optional(MessageOrigin),
  modelUsage: Schema.optional(ModelUsage),
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
const HookCallbackDiscriminant = Schema.Struct({
  request: Schema.Struct({ subtype: Schema.Literal("hook_callback") }),
});
const isHookCallbackRequest = Schema.is(HookCallbackDiscriminant);
const HookCallbackRequest = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Id,
  request: Schema.Struct({
    subtype: Schema.Literal("hook_callback"),
    input: Schema.optional(Schema.Unknown),
  }),
});
// Claude Code adds `agent_id` to hook input only when a native sub-agent makes the call.
const MainAgentHookInput = Schema.Struct({ agent_id: Schema.optional(Schema.Undefined) });
const isMainAgentHookInput = Schema.is(MainAgentHookInput);

export type ClaudeInboundFrame =
  | typeof Assistant.Type
  | typeof User.Type
  | typeof SystemInit.Type
  | typeof SystemEvent.Type
  | typeof BackgroundTasksChanged.Type
  | typeof TaskNotification.Type
  | typeof StreamEvent.Type
  | typeof ResultEvent.Type
  | typeof ControlResponse.Type
  | typeof HookCallbackRequest.Type;

export type ClaudeProtocolEvent =
  | {
      readonly type: "init";
      readonly cwd: string;
      readonly sessionId: string;
      readonly model: string;
      readonly hasMcpServerErrors: boolean;
      readonly cliVersion?: string | undefined;
    }
  | {
      readonly type: "user";
      readonly text: string;
      readonly toolResults: ReadonlyArray<{
        readonly id: string;
        readonly isError: boolean;
        readonly outputPreview?: string | undefined;
      }>;
      readonly uuid?: string | undefined;
      readonly sessionId?: string | undefined;
      readonly parentToolUseId?: string | undefined;
      readonly originKind?: string | undefined;
      readonly originSubkind?: string | undefined;
      readonly isSynthetic: boolean;
      readonly isReplay: boolean;
      readonly isMeta: boolean;
      readonly isCompactSummary: boolean;
      readonly contentKind: "text" | "blocks";
      readonly textLength: number;
    }
  | {
      readonly type: "assistant";
      /** Set when a native sub-agent, not the main session, produced the message. */
      readonly parentToolUseId?: string | undefined;
      readonly text?: string | undefined;
      readonly messageId?: string | undefined;
      readonly tools: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }>;
      readonly usage: SubagentUsage;
    }
  | { readonly type: "activity" }
  | {
      readonly type: "background_tasks";
      readonly taskIds: ReadonlyArray<string>;
      readonly sessionId?: string | undefined;
    }
  | {
      readonly type: "task_notification";
      readonly taskId: string;
      readonly sessionId?: string | undefined;
    }
  | {
      readonly type: "result";
      readonly isError: boolean;
      readonly subtype?: string | undefined;
      readonly stopReason?: string | undefined;
      readonly sessionId?: string | undefined;
      readonly userMessageUuid?: string | undefined;
      readonly originKind?: string | undefined;
      readonly originSubkind?: string | undefined;
      /** The process's running totals so far, summed across models. */
      readonly cumulativeUsage?: UsageComponents | undefined;
      /** The process's running cost estimate so far. */
      readonly totalCostUsd?: number | undefined;
      /** A successful turn's final assistant text. */
      readonly finalText?: string | undefined;
      readonly diagnostic?: string | undefined;
    }
  | {
      readonly type: "control_response";
      readonly requestId: string;
      readonly success: boolean;
      readonly diagnostic?: string | undefined;
      readonly response?: unknown;
    }
  | {
      /** Claude Code waits for the answer before it runs the hooked tool call. */
      readonly type: "hook_callback";
      readonly requestId: string;
      readonly caller: "main" | "native-sub-agent";
    }
  | { readonly type: "ignored" };

const decodeTextPart = decodeUnknownOrUndefined(TextPart);
const decodeToolResultPart = decodeUnknownOrUndefined(ToolResultPart);
const decodeToolUsePart = decodeUnknownOrUndefined(ToolUsePart);

const textFromContent = (content: string | ReadonlyArray<unknown>): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.flatMap(content, (part) => Arr.fromNullishOr(decodeTextPart(part)?.text)),
        "\n",
      );

const usageFromNative = (usage: typeof Usage.Type | undefined): SubagentUsage => {
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

const cumulativeUsageFromNative = (modelUsage: typeof ModelUsage.Type): UsageComponents =>
  Arr.reduce(
    Rec.values(modelUsage),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    (total, model) => ({
      input: total.input + (model.inputTokens ?? 0),
      output: total.output + (model.outputTokens ?? 0),
      cacheRead: total.cacheRead + (model.cacheReadInputTokens ?? 0),
      cacheWrite: total.cacheWrite + (model.cacheCreationInputTokens ?? 0),
    }),
  );

const userProtocolEvent = (event: typeof User.Type): ClaudeProtocolEvent => {
  const toolResults = Predicate.isString(event.message.content)
    ? []
    : Arr.flatMap(event.message.content, (part) => {
        const result = decodeToolResultPart(part);
        return result
          ? [
              {
                id: result.tool_use_id,
                isError: result.is_error === true,
                outputPreview: toolOutputPreview(result.content),
              },
            ]
          : [];
      });
  const text = textFromContent(event.message.content);
  return {
    type: "user",
    text,
    toolResults,
    contentKind: Predicate.isString(event.message.content) ? "text" : "blocks",
    textLength: text.length,
    ...(event.uuid && { uuid: event.uuid }),
    ...(event.session_id && { sessionId: event.session_id }),
    ...(event.parent_tool_use_id && { parentToolUseId: event.parent_tool_use_id }),
    ...(event.origin && { originKind: event.origin.kind }),
    ...(event.origin?.subkind && { originSubkind: event.origin.subkind }),
    isSynthetic: event.isSynthetic === true,
    isReplay: event.isReplay === true,
    isMeta: event.isMeta === true,
    isCompactSummary: event.isCompactSummary === true,
  };
};

const assistantProtocolEvent = (event: typeof Assistant.Type): ClaudeProtocolEvent => {
  const tools = Arr.flatMap(event.message.content, (part) => {
    const tool = decodeToolUsePart(part);
    return tool ? [{ id: tool.id, name: tool.name, input: tool.input }] : [];
  });
  const text = Str.trim(textFromContent(event.message.content));
  return {
    type: "assistant",
    ...(event.parent_tool_use_id && { parentToolUseId: event.parent_tool_use_id }),
    ...(text && { text }),
    ...(event.message.id && { messageId: event.message.id }),
    tools,
    usage: usageFromNative(event.message.usage),
  };
};

const resultProtocolEvent = (event: typeof ResultEvent.Type): ClaudeProtocolEvent => {
  const diagnostic =
    Str.trim(event.result ?? "") ||
    (event.errors === undefined
      ? undefined
      : Arr.join(
          Arr.filter(
            Arr.map(event.errors, (error) => Str.trim(error)),
            Boolean,
          ),
          "\n",
        ));
  const finalText = event.is_error === true ? "" : Str.trim(event.result ?? "");
  return {
    type: "result",
    isError: event.is_error === true,
    ...(event.subtype && { subtype: event.subtype }),
    ...(event.stop_reason && { stopReason: event.stop_reason }),
    ...(event.session_id && { sessionId: event.session_id }),
    ...(event.user_message_uuid && { userMessageUuid: event.user_message_uuid }),
    ...(event.origin && { originKind: event.origin.kind }),
    ...(event.origin?.subkind && { originSubkind: event.origin.subkind }),
    ...(event.modelUsage && { cumulativeUsage: cumulativeUsageFromNative(event.modelUsage) }),
    ...(event.total_cost_usd !== undefined && { totalCostUsd: event.total_cost_usd }),
    ...(finalText && { finalText }),
    ...(diagnostic && { diagnostic }),
  };
};

const decodeSystemEvent = Effect.fnUntraced(function* (
  value: Schema.Json,
): Effect.fn.Return<ClaudeProtocolEvent, Schema.SchemaError> {
  const system = yield* Schema.decodeUnknownEffect(SystemEvent)(value);
  if (system.subtype === "status") return { type: "activity" };
  if (system.subtype === "background_tasks_changed") {
    const changed = yield* Schema.decodeUnknownEffect(BackgroundTasksChanged)(value);
    return {
      type: "background_tasks",
      taskIds: Arr.filterMap(changed.tasks, (task) =>
        isBackgroundTaskId(task) ? Result.succeed(task.task_id) : Result.failVoid,
      ),
      ...(changed.session_id && { sessionId: changed.session_id }),
    };
  }
  if (system.subtype === "task_notification") {
    const notification = yield* Schema.decodeUnknownEffect(TaskNotification)(value);
    return {
      type: "task_notification",
      taskId: notification.task_id,
      ...(notification.session_id && { sessionId: notification.session_id }),
    };
  }
  if (system.subtype !== "init") return { type: "ignored" };
  const event = yield* Schema.decodeUnknownEffect(SystemInit)(value);
  return {
    type: "init",
    cwd: event.cwd,
    sessionId: event.session_id,
    model: event.model,
    hasMcpServerErrors: (event.mcp_server_errors?.length ?? 0) > 0,
    cliVersion: event.claude_code_version,
  };
});

const decodeControlResponseEvent = Effect.fnUntraced(function* (
  value: Schema.Json,
): Effect.fn.Return<ClaudeProtocolEvent, Schema.SchemaError> {
  const event = yield* Schema.decodeUnknownEffect(ControlResponse)(value);
  const requestId = event.request_id ?? event.response?.request_id;
  if (!requestId) {
    yield* Schema.decodeUnknownEffect(Schema.Struct({ request_id: Id }))(value);
    return { type: "ignored" } as const;
  }
  return {
    type: "control_response",
    requestId,
    success: event.response?.subtype === "success",
    ...(event.response?.error && { diagnostic: event.response.error }),
    ...(event.response?.response !== undefined && { response: event.response.response }),
  };
});

// The driver registers only hook callbacks, so it expects no other control request from Claude.
const decodeControlRequestEvent = (
  value: Schema.Json,
): Effect.Effect<ClaudeProtocolEvent, Schema.SchemaError> =>
  isHookCallbackRequest(value)
    ? Schema.decodeUnknownEffect(HookCallbackRequest)(value).pipe(
        Effect.map((event) => ({
          type: "hook_callback" as const,
          requestId: event.request_id,
          caller: isMainAgentHookInput(event.request.input)
            ? ("main" as const)
            : ("native-sub-agent" as const),
        })),
      )
    : Effect.succeed({ type: "ignored" as const });

export const decodeClaudeProtocolEvent = Effect.fnUntraced(function* (
  value: Schema.Json,
): Effect.fn.Return<ClaudeProtocolEvent, Schema.SchemaError> {
  const discriminant = yield* Schema.decodeUnknownEffect(Discriminant)(value);
  switch (discriminant.type) {
    case "system":
      return yield* decodeSystemEvent(value);
    case "user": {
      const event = yield* Schema.decodeUnknownEffect(User)(value);
      return userProtocolEvent(event);
    }
    case "assistant": {
      const event = yield* Schema.decodeUnknownEffect(Assistant)(value);
      return assistantProtocolEvent(event);
    }
    case "stream_event":
      yield* Schema.decodeUnknownEffect(StreamEvent)(value);
      return { type: "activity" };
    case "result": {
      const event = yield* Schema.decodeUnknownEffect(ResultEvent)(value);
      return resultProtocolEvent(event);
    }
    case "control_response":
      return yield* decodeControlResponseEvent(value);
    case "control_request":
      return yield* decodeControlRequestEvent(value);
    case undefined:
    default:
      return { type: "ignored" };
  }
});

const OversizedClaudeFields = Schema.Struct({
  type: Schema.optional(Name),
  "message.content.0.type": Schema.optional(Name),
  "message.content.0.tool_use_id": Schema.optional(Id),
});
const decodeOversizedClaudeFields = Schema.decodeUnknownOption(OversizedClaudeFields);

/**
 * Claude Code repeats a tool result's images or documents in its `user` line, so one large read can
 * push the line past the limit. Each such line carries one result whose id leads the content, so
 * the subagent can still close the tool. Every other oversized line stays a protocol error.
 */
export const oversizedClaudeProtocolEvent = (
  line: OversizedLine,
): ClaudeProtocolEvent | undefined => {
  const fields = decodeOversizedClaudeFields(Rec.fromEntries(jsonPrefixScalars(line.prefix)));
  if (Option.isNone(fields)) return undefined;
  const { type, "message.content.0.type": partType } = fields.value;
  const toolUseId = fields.value["message.content.0.tool_use_id"];
  if (type === "stream_event") return { type: "activity" };
  if (type !== "user" || partType !== "tool_result" || toolUseId === undefined) return undefined;
  return {
    type: "user",
    text: "",
    toolResults: [
      { id: toolUseId, isError: false, outputPreview: omittedOutputPreview(line.bytes) },
    ],
    contentKind: "blocks",
    textLength: 0,
    isSynthetic: false,
    isReplay: false,
    isMeta: false,
    isCompactSummary: false,
  };
};

export const decodeClaudeInitializeControlResponse =
  Schema.decodeUnknownEffect(InitializeControlResponse);

export const decodeClaudeMcpStatusControlResponse =
  Schema.decodeUnknownEffect(McpStatusControlResponse);

export type ClaudeUserFrame = ReturnType<typeof claudeUserFrame>;
export type ClaudeControlRequestFrame = ReturnType<
  typeof claudeInitializeFrame | typeof claudeMcpStatusFrame | typeof claudeInterruptFrame
>;
export type ClaudeHookResponseFrame = ReturnType<typeof claudeHookResponseFrame>;

export const claudeHookResponseFrame = (requestId: string, caller: "main" | "native-sub-agent") =>
  ({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: claudeMainAgentToolDecision(caller),
    },
  }) as const;

export const claudeUserFrame = (
  message: string,
  options: { readonly shouldQuery?: boolean | undefined; readonly uuid?: string | undefined } = {},
) =>
  ({
    type: "user",
    ...(options.uuid && { uuid: options.uuid }),
    message: { role: "user", content: message },
    ...(options.shouldQuery !== undefined && { shouldQuery: options.shouldQuery }),
  }) as const;

const controlFrame =
  <const Request extends { readonly subtype: string }>(request: Request) =>
  (requestId: string) =>
    ({ type: "control_request", request_id: requestId, request }) as const;

export const claudeInitializeFrame = controlFrame({
  subtype: "initialize",
  hooks: CLAUDE_HOOK_REGISTRATIONS,
});
export const claudeMcpStatusFrame = controlFrame({ subtype: "mcp_status" });
export const claudeInterruptFrame = controlFrame({ subtype: "interrupt", cancel_queued: true });
