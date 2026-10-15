import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  decodeQuestionnaireRequest,
  QuestionnaireRequestSchema,
  type AskUserRequest,
} from "pi-ask-user/protocol";
import { Check } from "typebox/value";
import type { BackendProxyResult } from "../backend/model.ts";
import { invalidRequest, type InvalidSubagentRequestError } from "../run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentToolName } from "../run/tool-policy.ts";
import { blankStringPath } from "./arguments.ts";
import { SubagentContractSchema, encodeSubagentContract } from "./contract-schema.ts";
import {
  SUBAGENT_TOOL_SCHEMAS,
  type SubagentToolArgs,
  type SubagentToolInput,
  type SubagentToolParameters,
} from "./schema.ts";

export interface SubagentProxyRequest {
  readonly tool: string;
  readonly argumentsJson: string;
}

export const encodeSubagentProxyInput = (input: SubagentToolInput): SubagentProxyRequest => ({
  tool: input.tool,
  argumentsJson: JSON.stringify(input.args),
});

const MAX_PROXY_JSON_CHARS = 2 * 1024 * 1024;
const decodeQuestionnaireJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(QuestionnaireRequestSchema),
  { onExcessProperty: "error" },
);

export const decodeQuestionnaireProxyRequest = (
  request: SubagentProxyRequest,
): AskUserRequest | InvalidSubagentRequestError => {
  if (request.tool !== "ask_user" || request.argumentsJson.length > 131_072)
    return invalid("Nested questionnaire arguments exceeded the structured request bound.");
  const decoded = decodeQuestionnaireJson(request.argumentsJson);
  const value = Option.isSome(decoded) ? decodeQuestionnaireRequest(decoded.value) : undefined;
  return value ?? invalid("Nested questionnaire arguments failed strict validation.");
};

export type SubagentProxyPayload =
  | BackendProxyResult
  | { readonly code: string; readonly message: string };

export const encodeSubagentProxyPayload = (value: SubagentProxyPayload): string | undefined => {
  try {
    const source = JSON.stringify(value);
    return source.length <= MAX_PROXY_JSON_CHARS ? source : undefined;
  } catch {
    return undefined;
  }
};

const ProxyResultSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("text"),
      text: Schema.String.check(Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS)),
    }),
  ).check(Schema.isMaxLength(64)),
  details: Schema.optional(Schema.Unknown),
  structuredContent: Schema.optionalKey(SubagentContractSchema),
  isError: Schema.optionalKey(Schema.Boolean),
});
const decodeProxyArgumentsJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeProxyResultJson = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyResultSchema), {
  onExcessProperty: "error",
});

export const decodeSubagentProxyResult = (source: string): AgentToolResult<unknown> | undefined => {
  if (source.length > MAX_PROXY_JSON_CHARS) return undefined;
  const decoded = decodeProxyResultJson(source);
  if (Option.isNone(decoded)) return undefined;
  return {
    content: [...decoded.value.content],
    details: decoded.value.details ?? {},
    ...(decoded.value.structuredContent !== undefined && {
      structuredContent: encodeSubagentContract(decoded.value.structuredContent),
    }),
    ...(decoded.value.isError !== undefined && { isError: decoded.value.isError }),
  };
};

const invalid = (message: string) => invalidRequest("proxy_request_invalid", message);

type ToolSchemas = {
  readonly [N in SubagentToolName]: {
    readonly parameters: SubagentToolParameters<N>;
    readonly validate?: (args: SubagentToolArgs<N>) => string | undefined;
  };
};
const TOOL_SCHEMAS: ToolSchemas = SUBAGENT_TOOL_SCHEMAS;

const isSubagentToolName = (tool: string): tool is SubagentToolName =>
  Object.hasOwn(TOOL_SCHEMAS, tool);

const decodeToolArguments = <N extends SubagentToolName>(
  tool: N,
  args: Schema.Json,
): SubagentToolInput<N> | undefined => {
  const { parameters, validate } = TOOL_SCHEMAS[tool];
  return Check(parameters, args) &&
    blankStringPath(args) === undefined &&
    validate?.(args) === undefined
    ? { tool, args }
    : undefined;
};

export const decodeSubagentProxyRequest = (
  request: SubagentProxyRequest,
): SubagentToolInput | InvalidSubagentRequestError => {
  if (request.argumentsJson.length > MAX_PROXY_JSON_CHARS)
    return invalid("Nested subagent request arguments were not bounded JSON.");
  const decoded = decodeProxyArgumentsJson(request.argumentsJson);
  if (Option.isNone(decoded))
    return invalid("Nested subagent request arguments were not bounded JSON.");
  const { tool } = request;
  if (!isSubagentToolName(tool)) return invalid("Nested Pi requested an unknown coordinator tool.");
  return (
    decodeToolArguments(tool, decoded.value) ??
    invalid(`Nested ${tool} arguments failed strict validation.`)
  );
};
