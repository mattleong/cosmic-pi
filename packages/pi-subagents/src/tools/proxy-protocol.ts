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
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import type { SubagentParentContext } from "../run/model.ts";
import { invalidRequest, type InvalidSubagentRequestError } from "../run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { isAgentToolName, type AgentToolName, type SubagentToolName } from "../run/tool-policy.ts";
import { blankStringPath } from "./arguments.ts";
import { SubagentContractSchema, encodeSubagentContract } from "./contract-schema.ts";
import {
  AGENT_TOOL_SCHEMAS,
  SUBAGENT_TOOL_SCHEMAS,
  type AgentToolInput,
  type SubagentToolArgs,
  type SubagentToolInput,
  type SubagentToolParameters,
} from "./schema.ts";

export interface SubagentProxyRequest {
  readonly tool: string;
  readonly argumentsJson: string;
}

export const encodeSubagentProxyInput = (
  input: SubagentToolInput | AgentToolInput,
): SubagentProxyRequest => ({
  tool: input.tool,
  argumentsJson: JSON.stringify(input.args),
});

const MAX_PROXY_JSON_CHARS = 2 * 1024 * 1024;
const ParentContextSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  sessionFile: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4096),
      Schema.isPattern(/^[^\0\r\n]+$/),
    ),
  ),
  leafId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  model: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(256), Schema.makeFilter(isSafeNativeModelSelector)),
  ),
  effort: Schema.Literals(SUBAGENT_EFFORTS),
  contextTokens: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});
const ParentEnvelopeSchema = Schema.Struct({
  parentContext: ParentContextSchema,
  argumentsJson: Schema.String.check(Schema.isMaxLength(MAX_PROXY_JSON_CHARS)),
});
const decodeParentEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(ParentEnvelopeSchema),
  {
    onExcessProperty: "error",
  },
);
const hasParentEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ parentContext: Schema.Unknown })),
);

/** The bridge adds facts outside public tool arguments; only an authenticated run may bind them. */
export const withSubagentProxyParent = (
  request: SubagentProxyRequest,
  parentContext: SubagentParentContext,
): SubagentProxyRequest => ({
  tool: request.tool,
  argumentsJson: JSON.stringify({ parentContext, argumentsJson: request.argumentsJson }),
});

export const decodeSubagentProxyParent = (
  request: SubagentProxyRequest,
):
  | { readonly request: SubagentProxyRequest; readonly parentContext?: SubagentParentContext }
  | InvalidSubagentRequestError => {
  if (request.argumentsJson.length > MAX_PROXY_JSON_CHARS)
    return invalid("Nested subagent request arguments exceeded their bound.");
  const decoded = decodeParentEnvelope(request.argumentsJson);
  if (Option.isSome(decoded))
    return {
      request: { tool: request.tool, argumentsJson: decoded.value.argumentsJson },
      parentContext: decoded.value.parentContext,
    };
  return Option.isSome(hasParentEnvelope(request.argumentsJson))
    ? invalid("Nested Pi parent context failed strict validation.")
    : { request };
};
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

type SubagentProxyPayload =
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

const decodeAgentToolArguments = <N extends AgentToolName>(
  tool: N,
  args: Schema.Json,
): AgentToolInput<N> | undefined =>
  Check(AGENT_TOOL_SCHEMAS[tool], args) && blankStringPath(args) === undefined
    ? { tool, args }
    : undefined;

/**
 * Decodes a nested `agent_*` call, or returns undefined for other tools. Arguments are the public
 * tool arguments alone: the root binds the caller from the authenticated channel, so a payload that
 * names a caller, ancestry, or parent context fails strict validation.
 */
export const decodeAgentProxyRequest = (
  request: SubagentProxyRequest,
): AgentToolInput | InvalidSubagentRequestError | undefined => {
  const { tool } = request;
  if (!isAgentToolName(tool)) return undefined;
  if (request.argumentsJson.length > MAX_PROXY_JSON_CHARS)
    return invalid("Nested agent request arguments were not bounded JSON.");
  const decoded = decodeProxyArgumentsJson(request.argumentsJson);
  if (Option.isNone(decoded))
    return invalid("Nested agent request arguments were not bounded JSON.");
  return (
    decodeAgentToolArguments(tool, decoded.value) ??
    invalid(`Nested ${tool} arguments failed strict validation.`)
  );
};
