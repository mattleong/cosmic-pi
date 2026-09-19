import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { isJsonObject, runtimeTypeName, type JsonObject, type JsonValue } from "pi-cosmic-core";
import { SupervisorDeliveryIdSchema, SupervisorRpcFailure } from "./protocol.ts";
import {
  isSupervisorMcpMessageArguments,
  isSupervisorMcpProxyArguments,
  isSupervisorMcpReportArguments,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  MAX_SUPERVISOR_MCP_PROXY_JSON_CHARS,
  MAX_SUPERVISOR_MCP_PROXY_TOOL_CHARS,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
  SUPERVISOR_MCP_PROXY_ARGUMENT_KEYS,
  SUPERVISOR_MCP_PROXY_TOOL_NAME,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "./mcp-contract.ts";

const MAX_ID_CHARS = 256;

export class McpToolCallFailure extends Data.TaggedError("McpToolCallFailure")<{
  readonly failure: unknown;
}> {}

export type RpcId = string | number;

export type DecodedMcpMessage =
  | {
      readonly method: "initialize";
      readonly id: RpcId;
      readonly protocolVersion: string;
      readonly piBridge: boolean;
    }
  | { readonly method: "notifications/initialized" }
  | { readonly method: "notifications/cancelled"; readonly requestId: RpcId }
  | { readonly method: "ping" | "tools/list"; readonly id: RpcId }
  | {
      readonly method: "tools/call";
      readonly id: RpcId;
      readonly name: string;
      readonly arguments: JsonValue | undefined;
    }
  | {
      readonly method: "unknown";
      readonly requestedMethod: string;
      readonly id?: RpcId | undefined;
    };

export type ToolCall = Extract<DecodedMcpMessage, { readonly method: "tools/call" }>;

type DecodedToolArguments =
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "proxy"; readonly tool: string; readonly argumentsJson: string }
  | {
      readonly kind: "report";
      readonly deliveryId: ReturnType<typeof SupervisorDeliveryIdSchema.make>;
      readonly report: string;
    };

export interface McpToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  isError?: true;
}

const own = (value: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const exactKeys = <ValueInput>(
  value: ValueInput,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string> = [],
): value is ValueInput & JsonObject =>
  isJsonObject(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => own(value, key));

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

const boundedMetadata = <ValueInput>(value: ValueInput, depth = 0): boolean => {
  if (depth > 6) return false;
  if (value === null || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (Predicate.isString(value)) return value.length <= 4096;
  if (Array.isArray(value))
    return value.length <= 64 && value.every((entry) => boundedMetadata(entry, depth + 1));
  if (!isJsonObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(([key, entry]) => key.length <= 128 && boundedMetadata(entry, depth + 1))
  );
};

const validMeta = <ParamsInput>(params: ParamsInput): boolean =>
  params === undefined ||
  (exactKeys(params, ["_meta"]) && (!own(params, "_meta") || boundedMetadata(params._meta)));

const messageInputSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
      pattern: SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
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
export const toolDefinitions = [
  {
    name: SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[0],
    description: "Publish bounded assignment progress to the parent projection.",
    inputSchema: messageInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[1],
    description:
      "Record one bounded non-blocking assignment warning in parent-visible run status; repeat it in the final report. Ask a question instead when the risk could invalidate work the parent is doing now.",
    inputSchema: messageInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[2],
    description:
      "Ask the parent this assignment's one correlated blocking question and wait for its exact reply.",
    inputSchema: messageInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_TOOL_NAMES[3],
    description:
      "Submit the complete bounded final report with a stable delivery identity for explicit idempotent retry.",
    inputSchema: {
      type: "object",
      properties: {
        delivery_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
          pattern: SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
        },
        report: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_REPORT_CHARS,
          pattern: SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
        },
      },
      required: SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
      additionalProperties: false,
    },
    annotations: { ...toolAnnotations, idempotentHint: true },
  },
];

export const proxyToolDefinition = {
  name: SUPERVISOR_MCP_PROXY_TOOL_NAME,
  description: "Private delegated-Pi coordinator proxy.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", minLength: 1, maxLength: MAX_SUPERVISOR_MCP_PROXY_TOOL_CHARS },
      arguments_json: { type: "string", maxLength: MAX_SUPERVISOR_MCP_PROXY_JSON_CHARS },
    },
    required: SUPERVISOR_MCP_PROXY_ARGUMENT_KEYS,
    additionalProperties: false,
  },
  annotations: toolAnnotations,
} as const;

export const decodeToolArguments = <ValueInput>(
  name: string,
  value: ValueInput,
  piBridgeClient: boolean,
): DecodedToolArguments | undefined => {
  if (name === SUPERVISOR_MCP_PROXY_TOOL_NAME) {
    if (!piBridgeClient || !isSupervisorMcpProxyArguments(value)) return undefined;
    return { kind: "proxy", tool: value.tool, argumentsJson: value.arguments_json };
  }
  if (name === SUPERVISOR_MCP_TOOL_NAMES[3]) {
    if (!isSupervisorMcpReportArguments(value)) return undefined;
    const deliveryId = SupervisorDeliveryIdSchema.makeOption(value.delivery_id);
    if (Option.isNone(deliveryId)) return undefined;
    return { kind: "report", deliveryId: deliveryId.value, report: value.report };
  }
  if (
    !SUPERVISOR_MCP_MESSAGE_TOOL_NAMES.some((toolName) => toolName === name) ||
    !isSupervisorMcpMessageArguments(value)
  )
    return undefined;
  return { kind: "message", message: value.message };
};

const decodeInitializeMessage = <ParamsInput>(
  params: ParamsInput,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  if (
    id === undefined ||
    !exactKeys(
      params,
      ["protocolVersion", "capabilities", "clientInfo", "_meta"],
      ["protocolVersion"],
    ) ||
    !boundedString(params.protocolVersion, 64) ||
    (own(params, "_meta") && !boundedMetadata(params._meta))
  )
    return undefined;
  return {
    method: "initialize",
    id,
    protocolVersion: params.protocolVersion,
    piBridge:
      isJsonObject(params.clientInfo) && params.clientInfo.name === "pi-subagents-pi-bridge",
  };
};

const decodeInitializedMessage = <ParamsInput>(
  params: ParamsInput,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined =>
  id === undefined && validMeta(params) ? { method: "notifications/initialized" } : undefined;

const decodeCancelledMessage = <ParamsInput>(
  params: ParamsInput,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  if (
    id !== undefined ||
    !exactKeys(params, ["requestId", "reason", "_meta"], ["requestId"]) ||
    !validRpcId(params.requestId) ||
    (params.reason !== undefined && !boundedString(params.reason, 512, false)) ||
    (own(params, "_meta") && !boundedMetadata(params._meta))
  )
    return undefined;
  return { method: "notifications/cancelled", requestId: params.requestId };
};

const decodeRequestMessage = <ParamsInput>(
  method: "ping" | "tools/list",
  params: ParamsInput,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined =>
  id !== undefined && validMeta(params) ? { method, id } : undefined;

const decodeToolCallMessage = <ParamsInput>(
  params: ParamsInput,
  id: RpcId | undefined,
): DecodedMcpMessage | undefined => {
  if (
    id === undefined ||
    !exactKeys(params, ["name", "arguments", "_meta"], ["name", "arguments"]) ||
    !boundedString(params.name, 128) ||
    (own(params, "_meta") && !boundedMetadata(params._meta))
  )
    return undefined;
  return { method: "tools/call", id, name: params.name, arguments: params.arguments };
};

const decodeUnknownMessage = (requestedMethod: string, id: RpcId | undefined): DecodedMcpMessage =>
  id === undefined
    ? { method: "unknown", requestedMethod }
    : { method: "unknown", requestedMethod, id };

export const decodeMcpMessage = <ValueInput>(value: ValueInput): DecodedMcpMessage | undefined => {
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
  switch (value.method) {
    case "initialize":
      return decodeInitializeMessage(value.params, id);
    case "notifications/initialized":
      return decodeInitializedMessage(value.params, id);
    case "notifications/cancelled":
      return decodeCancelledMessage(value.params, id);
    case "ping":
    case "tools/list":
      return decodeRequestMessage(value.method, value.params, id);
    case "tools/call":
      return decodeToolCallMessage(value.params, id);
    default:
      return decodeUnknownMessage(value.method, id);
  }
};

export const toolResult = (text: string, isError = false): McpToolResult => {
  const result: McpToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
};

const failureCode = <FailureInput>(failure: FailureInput): string | undefined =>
  failure instanceof SupervisorRpcFailure
    ? failure.code
    : isJsonObject(failure) && Predicate.isString(failure.code)
      ? failure.code
      : undefined;

const failureMessage = <FailureInput>(failure: FailureInput): string | undefined =>
  failure instanceof SupervisorRpcFailure
    ? failure.message
    : isJsonObject(failure) && boundedString(failure.message, 512)
      ? failure.message
      : undefined;

const isCancellationCode = (code: string | undefined): boolean =>
  code === "request_cancelled" ||
  code === "question_cancelled" ||
  code === "question_cancelled_by_report" ||
  code === "question_assignment_advanced";

export const toolResponseFromExit = (
  id: RpcId,
  exit: Exit.Exit<McpToolResult, McpToolCallFailure>,
) => {
  if (Exit.isSuccess(exit)) return { jsonrpc: "2.0", id, result: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause))
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32800, message: "MCP request was cancelled." },
    };
  const wrapped = Cause.findErrorOption(exit.cause);
  const failure = Option.isSome(wrapped) ? wrapped.value.failure : undefined;
  const code = failureCode(failure);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: isCancellationCode(code) ? -32800 : -32000,
      message: failureMessage(failure) ?? "Private supervisor tool delivery failed.",
    },
  };
};
