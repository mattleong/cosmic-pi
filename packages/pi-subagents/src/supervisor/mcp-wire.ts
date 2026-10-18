import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { isJsonObject, runtimeTypeName, type JsonObject, type JsonValue } from "pi-cosmic-core";
import type { SupervisorRpcFailure } from "./protocol.ts";
import type { SupervisorToolFailure } from "./tool-call.ts";
import {
  MAX_SUPERVISOR_MCP_AGENT_ID_CHARS,
  MAX_SUPERVISOR_MCP_AGENT_IDS,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  MAX_SUPERVISOR_MCP_THREAD_ID_CHARS,
  SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY,
  SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS,
  SUPERVISOR_MCP_AGENT_TOOL_NAMES,
  SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "./mcp-contract.ts";

const MAX_ID_CHARS = 256;

export type RpcId = string | number;

export type DecodedMcpMessage =
  | { readonly method: "initialize"; readonly id: RpcId; readonly protocolVersion: string }
  | { readonly method: "notifications/initialized" }
  | { readonly method: "notifications/cancelled"; readonly requestId: RpcId }
  | { readonly method: "ping" | "tools/list"; readonly id: RpcId }
  | {
      readonly method: "tools/call";
      readonly id: RpcId;
      readonly name: string;
      readonly arguments: JsonValue | undefined;
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

const own = (value: JsonObject, key: string): boolean => Object.hasOwn(value, key);

const exactKeys = <ValueInput>(
  value: ValueInput,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string> = [],
): value is ValueInput & JsonObject =>
  isJsonObject(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => own(value, key)) &&
  (!own(value, "_meta") || boundedMetadata(value._meta));

export const boundedString = <ValueInput>(
  value: ValueInput,
  maximum: number,
  nonEmpty = true,
): value is ValueInput & string =>
  Predicate.isString(value) && value.length <= maximum && (!nonEmpty || value.trim().length > 0);

export const validRpcId = <ValueInput>(value: ValueInput): value is ValueInput & RpcId =>
  (Predicate.isString(value) && value.length > 0 && value.length <= MAX_ID_CHARS) ||
  (Predicate.isNumber(value) && Number.isSafeInteger(value));

export const rpcKey = (value: RpcId): string => `${runtimeTypeName(value)}:${String(value)}`;

const isJsonArray = (value: Schema.Json | undefined): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);

const boundedMetadata = (value: Schema.Json | undefined, depth = 0): boolean => {
  if (depth > 6) return false;
  if (value === null || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (Predicate.isString(value)) return value.length <= 4096;
  if (isJsonArray(value))
    return value.length <= 64 && value.every((entry) => boundedMetadata(entry, depth + 1));
  if (!isJsonObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(([key, entry]) => key.length <= 128 && boundedMetadata(entry, depth + 1))
  );
};

const validMeta = (params: Schema.Json | undefined): boolean =>
  params === undefined || exactKeys(params, ["_meta"]);

const messageInputSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
    },
  },
  required: SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
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
const messageTool = (name: string, description: string) => ({
  name,
  description,
  inputSchema: messageInputSchema,
  annotations: toolAnnotations,
});
export const toolDefinitions = [
  messageTool(
    SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[0],
    "Publish bounded assignment progress to the parent projection.",
  ),
  messageTool(
    SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[1],
    "Record one bounded non-blocking assignment warning in parent-visible run status; repeat it in the final report. Ask a question instead when the risk could invalidate work the parent is doing now.",
  ),
  messageTool(
    SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[2],
    "Main agent only: ask the parent this assignment's one correlated blocking question and wait for its exact reply.",
  ),
  {
    name: SUPERVISOR_MCP_TOOL_NAMES[3],
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
    name: SUPERVISOR_MCP_AGENT_TOOL_NAMES[0],
    description:
      'List the agents in this session: the main agent "main" and every subagent at any depth, with ID, name, state, role, runtime, and parent.',
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
    name: SUPERVISOR_MCP_AGENT_TOOL_NAMES[1],
    description:
      "Main agent only: send one bounded message to another agent in this session now. A running agent receives it as guidance, an idle main agent is woken, and a finished Pi run is resumed. Do not resend after an uncertain result.",
    inputSchema: {
      type: "object",
      properties: {
        to: { ...agentIdSchema, description: "One agent ID from agent_list, or main." },
        message: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
        },
      },
      required: SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS,
      additionalProperties: false,
    },
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_AGENT_TOOL_NAMES[2],
    description:
      "Read agents' last assistant messages, or a finished run's report or error, without consuming anything.",
    inputSchema: {
      type: "object",
      properties: {
        [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY]: {
          ...agentIdsSchema("One to 12 agent IDs from agent_list, or main."),
          minItems: 1,
        },
      },
      required: [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY],
      additionalProperties: false,
    },
    annotations: { ...toolAnnotations, readOnlyHint: true, idempotentHint: true },
  },
];

const decodeInitializeMessage = (
  params: Schema.Json | undefined,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  if (
    id === undefined ||
    !exactKeys(
      params,
      ["protocolVersion", "capabilities", "clientInfo", "_meta"],
      ["protocolVersion"],
    ) ||
    !boundedString(params.protocolVersion, 64)
  )
    return undefined;
  return { method: "initialize", id, protocolVersion: params.protocolVersion };
};

const decodeInitializedMessage = (
  params: Schema.Json | undefined,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined =>
  id === undefined && validMeta(params) ? { method: "notifications/initialized" } : undefined;

const decodeCancelledMessage = (
  params: Schema.Json | undefined,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  if (
    id !== undefined ||
    !exactKeys(params, ["requestId", "reason", "_meta"], ["requestId"]) ||
    !validRpcId(params.requestId) ||
    (params.reason !== undefined && !boundedString(params.reason, 512, false))
  )
    return undefined;
  return { method: "notifications/cancelled", requestId: params.requestId };
};

const decodeRequestMessage = (
  method: "ping" | "tools/list",
  params: Schema.Json | undefined,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined =>
  id !== undefined && validMeta(params) ? { method, id } : undefined;

const decodeToolCallMessage = (
  params: Schema.Json | undefined,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  if (
    id === undefined ||
    !exactKeys(params, ["name", "arguments", "_meta"], ["name", "arguments"]) ||
    !boundedString(params.name, 128)
  )
    return undefined;
  const nativeThreadId = callerThreadId(params._meta);
  return {
    method: "tools/call",
    id,
    name: params.name,
    arguments: params.arguments,
    ...(nativeThreadId !== undefined && { nativeThreadId }),
  };
};

// Codex names the calling thread, including a native sub-agent's own thread, in `_meta.threadId`.
const callerThreadId = (meta: Schema.Json | undefined): string | undefined => {
  if (!isJsonObject(meta)) return undefined;
  const threadId = meta.threadId;
  return boundedString(threadId, MAX_SUPERVISOR_MCP_THREAD_ID_CHARS) ? threadId : undefined;
};

const decodeMethodMessage = (
  method: string,
  params: Schema.Json | undefined,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  switch (method) {
    case "initialize":
      return decodeInitializeMessage(params, id);
    case "notifications/initialized":
      return decodeInitializedMessage(params, id);
    case "notifications/cancelled":
      return decodeCancelledMessage(params, id);
    case "ping":
    case "tools/list":
      return decodeRequestMessage(method, params, id);
    case "tools/call":
      return decodeToolCallMessage(params, id);
    default:
      return { method: "unknown", ...(id !== undefined && { id }) };
  }
};

export const decodeMcpMessage = (value: Schema.Json): DecodedMcpMessage | undefined => {
  if (
    !exactKeys(value, ["jsonrpc", "id", "method", "params"], ["jsonrpc", "method"]) ||
    value.jsonrpc !== "2.0" ||
    !Predicate.isString(value.method) ||
    value.method.length < 1 ||
    value.method.length > 128
  )
    return undefined;
  const rawId = value.id;
  const id = validRpcId(rawId) ? rawId : undefined;
  if (own(value, "id") && id === undefined) return undefined;
  return decodeMethodMessage(value.method, value.params, id);
};

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
