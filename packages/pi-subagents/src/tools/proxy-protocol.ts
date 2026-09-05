import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  decodeQuestionnaireRequest,
  QuestionnaireRequestSchema,
  type AskUserRequest,
} from "pi-ask-user/protocol";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  AwaitParameters,
  claimsOperationError,
  ClaimsParameters,
  LifecycleParameters,
  ListParameters,
  ModelsParameters,
  RenameParameters,
  ReplyParameters,
  SendParameters,
  StartParameters,
  StatusParameters,
  type SubagentToolInput,
} from "./schema.ts";

export interface SubagentProxyRequest {
  readonly tool: string;
  readonly argumentsJson: string;
}

export const encodeSubagentProxyInput = (input: SubagentToolInput): SubagentProxyRequest => {
  switch (input.action) {
    case "interrupt":
    case "resume":
    case "retry":
    case "stop":
      return { tool: SUBAGENT_TOOL_NAME.lifecycle, argumentsJson: JSON.stringify(input) };
    case "claims":
      return { tool: SUBAGENT_TOOL_NAME.claims, argumentsJson: JSON.stringify(input.operation) };
    default: {
      const { action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAME[action], argumentsJson: JSON.stringify(args) };
    }
  }
};

const MAX_PROXY_JSON_CHARS = 2 * 1024 * 1024;
const decodeQuestionnaireJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(QuestionnaireRequestSchema),
  { onExcessProperty: "error" },
);

/** A separate bounded wire request, never a synthetic SubagentToolInput action. */
export const decodeQuestionnaireProxyRequest = (
  request: SubagentProxyRequest,
): AskUserRequest | InvalidSubagentRequestError => {
  if (request.tool !== "ask_user" || request.argumentsJson.length > 131_072)
    return invalid("Nested questionnaire arguments exceeded the structured request bound.");
  const decoded = decodeQuestionnaireJson(request.argumentsJson);
  const value = Option.isSome(decoded) ? decodeQuestionnaireRequest(decoded.value) : undefined;
  return value ?? invalid("Nested questionnaire arguments failed strict validation.");
};

export const encodeSubagentProxyPayload = <ValueInput>(value: ValueInput): string | undefined => {
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
});
const decodeProxyArgumentsJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeProxyResultJson = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyResultSchema), {
  onExcessProperty: "error",
});

/** Strict client-side decode for private root coordinator proxy responses. */
export const decodeSubagentProxyResult = (source: string): AgentToolResult<unknown> | undefined => {
  const decoded = decodeProxyResultJson(source);
  if (Option.isNone(decoded)) return undefined;
  return { content: [...decoded.value.content], details: decoded.value.details ?? {} };
};

const invalid = (message: string) =>
  new InvalidSubagentRequestError({ code: "proxy_request_invalid", message });

const decodeTaggedArguments = <
  S extends TSchema,
  A extends SubagentToolInput["action"],
  ValueInput,
>(
  tool: string,
  schema: S,
  action: A,
  args: ValueInput,
): (Static<S> & { readonly action: A }) | InvalidSubagentRequestError =>
  Check(schema, args)
    ? { ...args, action }
    : invalid(`Nested ${tool} arguments failed strict validation.`);

/** Strict server-side decode for authenticated private Pi proxy calls. */
export const decodeSubagentProxyRequest = (
  request: SubagentProxyRequest,
): SubagentToolInput | InvalidSubagentRequestError => {
  if (request.argumentsJson.length > MAX_PROXY_JSON_CHARS)
    return invalid("Nested subagent request arguments were not bounded JSON.");
  const decoded = decodeProxyArgumentsJson(request.argumentsJson);
  if (Option.isNone(decoded))
    return invalid("Nested subagent request arguments were not bounded JSON.");
  const args = decoded.value;
  switch (request.tool) {
    case SUBAGENT_TOOL_NAME.models:
      return decodeTaggedArguments(request.tool, ModelsParameters, "models", args);
    case SUBAGENT_TOOL_NAME.start:
      return decodeTaggedArguments(request.tool, StartParameters, "start", args);
    case SUBAGENT_TOOL_NAME.list:
      return decodeTaggedArguments(request.tool, ListParameters, "list", args);
    case SUBAGENT_TOOL_NAME.status:
      return decodeTaggedArguments(request.tool, StatusParameters, "status", args);
    case SUBAGENT_TOOL_NAME.await:
      return decodeTaggedArguments(request.tool, AwaitParameters, "await", args);
    case SUBAGENT_TOOL_NAME.send:
      return decodeTaggedArguments(request.tool, SendParameters, "send", args);
    case SUBAGENT_TOOL_NAME.reply:
      return decodeTaggedArguments(request.tool, ReplyParameters, "reply", args);
    case SUBAGENT_TOOL_NAME.lifecycle:
      return Check(LifecycleParameters, args) &&
        (args.action === "resume" || args.message === undefined)
        ? args
        : invalid("Nested subagent_lifecycle arguments failed strict validation.");
    case SUBAGENT_TOOL_NAME.rename:
      return decodeTaggedArguments(request.tool, RenameParameters, "rename", args);
    case SUBAGENT_TOOL_NAME.claims:
      return Check(ClaimsParameters, args) && claimsOperationError(args) === undefined
        ? { action: "claims", operation: args }
        : invalid("Nested subagent_claims arguments failed strict validation.");
    default:
      return invalid("Nested Pi requested an unknown coordinator tool.");
  }
};
