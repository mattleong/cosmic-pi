import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isJsonObject, runtimeTypeName } from "pi-cosmic-core";
import { AGENT_TOOL_NAME, CONTACT_PARENT_TOOL_NAME } from "../run/tool-policy.ts";
import type { SupervisorRpcFailure } from "./protocol.ts";
import type { SupervisorToolFailure } from "./tool-call.ts";
import {
  MAX_SUPERVISOR_MCP_AGENT_ID_CHARS,
  MAX_SUPERVISOR_MCP_AGENT_IDS,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_AGENT_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_CONTACT_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  MAX_SUPERVISOR_MCP_THREAD_ID_CHARS,
  SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY,
  SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS,
  SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_CONTACT_KINDS,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_REPORT_TOOL_NAME,
  SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY,
} from "./mcp-contract.ts";

const MAX_ID_CHARS = 256;
const MAX_METHOD_CHARS = 128;
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ENTRIES = 64;
const MAX_METADATA_KEY_CHARS = 128;
const MAX_METADATA_STRING_CHARS = 4096;

const RpcIdSchema = Schema.Union([
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ID_CHARS)),
  Schema.Number.check(Schema.isInt()),
]);
export type RpcId = typeof RpcIdSchema.Type;

export type DecodedMcpMessage =
  | { readonly method: "initialize"; readonly id: RpcId; readonly protocolVersion: string }
  | { readonly method: "notifications/initialized" }
  | { readonly method: "notifications/cancelled"; readonly requestId: RpcId }
  | { readonly method: "ping" | "tools/list"; readonly id: RpcId }
  | {
      readonly method: "tools/call";
      readonly id: RpcId;
      readonly name: string;
      readonly arguments: Schema.Json;
      /** The native thread making the call, when the runtime names it in the request metadata. */
      readonly nativeThreadId?: string | undefined;
    }
  | {
      readonly method: "unknown";
      readonly id?: RpcId | undefined;
    };

export type ToolCall = Extract<DecodedMcpMessage, { readonly method: "tools/call" }>;

type McpToolResult = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: true;
};

export const boundedString = <ValueInput>(
  value: ValueInput,
  maximum: number,
  nonEmpty = true,
): value is ValueInput & string =>
  Predicate.isString(value) && value.length <= maximum && (!nonEmpty || value.trim().length > 0);

const isRpcId = Schema.is(RpcIdSchema);
export const validRpcId = <ValueInput>(value: ValueInput): value is ValueInput & RpcId =>
  isRpcId(value);

export const rpcKey = (value: RpcId): string => `${runtimeTypeName(value)}:${String(value)}`;

const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);

const boundedMetadata = (value: Schema.Json, depth = 0): boolean => {
  if (depth > MAX_METADATA_DEPTH) return false;
  if (value === null || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (Predicate.isString(value)) return value.length <= MAX_METADATA_STRING_CHARS;
  if (isJsonArray(value))
    return (
      value.length <= MAX_METADATA_ENTRIES &&
      value.every((entry) => boundedMetadata(entry, depth + 1))
    );
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_METADATA_ENTRIES &&
    entries.every(
      ([key, entry]) => key.length <= MAX_METADATA_KEY_CHARS && boundedMetadata(entry, depth + 1),
    )
  );
};

const boundedText = (maximum: number) =>
  Schema.String.check(
    Schema.isMaxLength(maximum),
    Schema.makeFilter((text: string) => text.trim().length > 0),
  );
/** Request metadata the runtime may attach anywhere, bounded in depth, breadth, and size. */
const MetadataSchema = Schema.Json.check(Schema.makeFilter((value) => boundedMetadata(value)));
const metadata = { _meta: Schema.optionalKey(MetadataSchema) };
const MetadataOnlyParams = Schema.optionalKey(Schema.Struct(metadata));
const JsonRpcVersion = Schema.Literal("2.0");

const InitializeMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: RpcIdSchema,
  method: Schema.Literal("initialize"),
  params: Schema.Struct({
    protocolVersion: boundedText(64),
    capabilities: Schema.optionalKey(Schema.Json),
    clientInfo: Schema.optionalKey(Schema.Json),
    ...metadata,
  }),
});
const InitializedMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  method: Schema.Literal("notifications/initialized"),
  params: MetadataOnlyParams,
});
const CancelledMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  method: Schema.Literal("notifications/cancelled"),
  params: Schema.Struct({
    requestId: RpcIdSchema,
    reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
    ...metadata,
  }),
});
const RequestMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: RpcIdSchema,
  method: Schema.Literals(["ping", "tools/list"]),
  params: MetadataOnlyParams,
});
const ToolCallMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: RpcIdSchema,
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: boundedText(128),
    arguments: Schema.Json,
    ...metadata,
  }),
});
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
]);
// A method this server doesn't serve; a known method whose shape is wrong is rejected instead.
const UnknownMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: Schema.optionalKey(RpcIdSchema),
  method: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_METHOD_CHARS),
    Schema.makeFilter((method: string) => !KNOWN_METHODS.has(method)),
  ),
  params: Schema.optionalKey(Schema.Json),
});
const exactMessage = { onExcessProperty: "error" } as const;
const decodeServedMessage = Schema.decodeUnknownResult(
  Schema.Union([
    InitializeMessage,
    InitializedMessage,
    CancelledMessage,
    RequestMessage,
    ToolCallMessage,
  ]),
  exactMessage,
);
const decodeUnservedMessage = Schema.decodeUnknownResult(UnknownMessage, exactMessage);

// Codex names the calling thread, including a native sub-agent's own thread, in `_meta.threadId`.
const callerThreadId = (meta: Schema.Json | undefined): string | undefined => {
  if (!isJsonObject(meta)) return undefined;
  const threadId = meta.threadId;
  return boundedString(threadId, MAX_SUPERVISOR_MCP_THREAD_ID_CHARS) ? threadId : undefined;
};

export const decodeMcpMessage = (value: Schema.Json): DecodedMcpMessage | undefined => {
  const served = decodeServedMessage(value);
  if (Result.isFailure(served))
    return Result.match(decodeUnservedMessage(value), {
      onFailure: () => undefined,
      onSuccess: ({ id }) => ({ method: "unknown", ...(id !== undefined && { id }) }),
    });
  const message = served.success;
  switch (message.method) {
    case "initialize":
      return {
        method: "initialize",
        id: message.id,
        protocolVersion: message.params.protocolVersion,
      };
    case "notifications/initialized":
      return { method: "notifications/initialized" };
    case "notifications/cancelled":
      return { method: "notifications/cancelled", requestId: message.params.requestId };
    case "ping":
    case "tools/list":
      return { method: message.method, id: message.id };
    case "tools/call": {
      const nativeThreadId = callerThreadId(message.params._meta);
      return {
        method: "tools/call",
        id: message.id,
        name: message.params.name,
        arguments: message.params.arguments,
        ...(nativeThreadId !== undefined && { nativeThreadId }),
      };
    }
  }
  return absurd<DecodedMcpMessage>(message);
};

const contactInputSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: SUPERVISOR_MCP_CONTACT_KINDS },
    message: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_CONTACT_CHARS,
    },
  },
  required: SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS,
  additionalProperties: false,
} as const;
const toolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const agentIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_SUPERVISOR_MCP_AGENT_ID_CHARS,
} as const;
const agentIdsSchema = (description: string) =>
  ({
    type: "array",
    description,
    items: agentIdSchema,
    maxItems: MAX_SUPERVISOR_MCP_AGENT_IDS,
  }) as const;
export const toolDefinitions = [
  {
    name: CONTACT_PARENT_TOOL_NAME,
    description:
      "Main agent only: contact your parent. kind=progress publishes bounded assignment progress; kind=warning records a non-blocking warning in parent-visible run status, which you also repeat in the final report; kind=question asks a blocking question and waits for the parent's exact reply; only one question waits at a time. Ask a question instead of warning when the risk could invalidate work the parent is doing now.",
    inputSchema: contactInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_REPORT_TOOL_NAME,
    description:
      "Main agent only: submit the complete bounded final report with a stable delivery identity for explicit idempotent retry.",
    inputSchema: {
      type: "object",
      properties: {
        delivery_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
        },
        report: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_REPORT_CHARS,
        },
      },
      required: SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
      additionalProperties: false,
    },
    annotations: { ...toolAnnotations, idempotentHint: true },
  },
  {
    name: AGENT_TOOL_NAME.list,
    description:
      'List every agent in this session: the main agent "main" and every subagent at any depth, with ID, name, state, role, runtime and model, worktree proposal, whether it waits on its parent, and parent.',
    inputSchema: {
      type: "object",
      properties: {
        [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY]: agentIdsSchema(
          "Up to 12 agent IDs to show; omit to list every agent.",
        ),
      },
      additionalProperties: false,
    },
    annotations: { ...toolAnnotations, readOnlyHint: true, idempotentHint: true },
  },
  {
    name: AGENT_TOOL_NAME.send,
    description:
      "Main agent only: send one bounded message now to any other agent in this session. A running agent receives it as guidance and an idle main agent is woken; only a run's ancestors can resume it once it has paused or finished. Do not resend after an unconfirmed or uncertain result.",
    inputSchema: {
      type: "object",
      properties: {
        to: { ...agentIdSchema, description: "One agent ID from agent_list, or main." },
        message: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_AGENT_MESSAGE_CHARS,
        },
      },
      required: SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS,
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: AGENT_TOOL_NAME.read,
    description:
      "Read up to 12 agents in this session: each run's status card and latest assistant message, or a finished run's saved report file or error, and main's latest message. verbose adds route, capability, process, and timing details. Reading never consumes anything.",
    inputSchema: {
      type: "object",
      properties: {
        [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY]: {
          ...agentIdsSchema("One to 12 agent IDs from agent_list, or main."),
          minItems: 1,
        },
        [SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY]: {
          type: "boolean",
          description: "Add route, capability, process, and timing details to status cards.",
        },
      },
      required: [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY],
      additionalProperties: false,
    },
    annotations: { ...toolAnnotations, readOnlyHint: true, idempotentHint: true },
  },
];

export const toolResult = (text: string, isError = false): McpToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError: true as const }),
});

const isCancellationCode = (code: string | undefined): boolean =>
  code === "question_cancelled" ||
  code === "question_cancelled_by_report" ||
  code === "question_assignment_advanced";

export const toolResponseFromExit = (
  id: RpcId,
  exit: Exit.Exit<McpToolResult, SupervisorRpcFailure | SupervisorToolFailure>,
) => {
  if (Exit.isSuccess(exit)) return { jsonrpc: "2.0", id, result: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause))
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32800, message: "MCP request was cancelled." },
    };
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: isCancellationCode(failure?.code) ? -32800 : -32000,
      message: failure?.message ?? "Private supervisor tool delivery failed.",
    },
  };
};
