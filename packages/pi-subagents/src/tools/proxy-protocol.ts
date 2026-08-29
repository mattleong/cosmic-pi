import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Check } from "typebox/value";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import {
  AwaitParameters,
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
    case "models": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[0], argumentsJson: JSON.stringify(args) };
    }
    case "start": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[1], argumentsJson: JSON.stringify(args) };
    }
    case "list":
      return { tool: SUBAGENT_TOOL_NAMES[2], argumentsJson: "{}" };
    case "status": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[3], argumentsJson: JSON.stringify(args) };
    }
    case "await": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[4], argumentsJson: JSON.stringify(args) };
    }
    case "send": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[5], argumentsJson: JSON.stringify(args) };
    }
    case "reply": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[6], argumentsJson: JSON.stringify(args) };
    }
    case "interrupt":
    case "resume":
    case "retry":
    case "stop":
      return { tool: SUBAGENT_TOOL_NAMES[7], argumentsJson: JSON.stringify(input) };
    case "rename": {
      const { action: _action, ...args } = input;
      return { tool: SUBAGENT_TOOL_NAMES[8], argumentsJson: JSON.stringify(args) };
    }
    case "claims":
      return { tool: SUBAGENT_TOOL_NAMES[9], argumentsJson: JSON.stringify(input.operation) };
  }
};

export const encodeSubagentProxyPayload = <ValueInput>(value: ValueInput): string | undefined => {
  try {
    const source = JSON.stringify(value);
    return source.length <= 2 * 1024 * 1024 ? source : undefined;
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

/** Strict client-side decode for private root coordinator proxy responses. */
export const decodeSubagentProxyResult = (source: string): AgentToolResult<unknown> | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyResultSchema), {
    onExcessProperty: "error",
  })(source);
  if (Option.isNone(decoded)) return undefined;
  return { content: [...decoded.value.content], details: decoded.value.details ?? {} };
};

const invalid = (message: string) =>
  new InvalidSubagentRequestError({ code: "proxy_request_invalid", message });

/** Strict server-side decode for authenticated private Pi proxy calls. */
export const decodeSubagentProxyRequest = (
  request: SubagentProxyRequest,
): SubagentToolInput | InvalidSubagentRequestError => {
  let args: unknown;
  try {
    if (request.argumentsJson.length > 2 * 1024 * 1024) throw new Error("oversized");
    args = JSON.parse(request.argumentsJson);
  } catch {
    return invalid("Nested subagent request arguments were not bounded JSON.");
  }
  switch (request.tool) {
    case SUBAGENT_TOOL_NAMES[0]:
      return Check(ModelsParameters, args)
        ? { ...args, action: "models" }
        : invalid("Nested subagent_models arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[1]:
      return Check(StartParameters, args)
        ? { ...args, action: "start" }
        : invalid("Nested subagent_start arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[2]:
      return Check(ListParameters, args)
        ? { ...args, action: "list" }
        : invalid("Nested subagent_list arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[3]:
      return Check(StatusParameters, args)
        ? { ...args, action: "status" }
        : invalid("Nested subagent_status arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[4]:
      return Check(AwaitParameters, args)
        ? { ...args, action: "await" }
        : invalid("Nested subagent_await arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[5]:
      return Check(SendParameters, args)
        ? { ...args, action: "send" }
        : invalid("Nested subagent_send arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[6]:
      return Check(ReplyParameters, args)
        ? { ...args, action: "reply" }
        : invalid("Nested subagent_reply arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[7]:
      return Check(LifecycleParameters, args)
        ? args
        : invalid("Nested subagent_lifecycle arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[8]:
      return Check(RenameParameters, args)
        ? { ...args, action: "rename" }
        : invalid("Nested subagent_rename arguments failed strict validation.");
    case SUBAGENT_TOOL_NAMES[9]:
      return Check(ClaimsParameters, args)
        ? { action: "claims", operation: args }
        : invalid("Nested subagent_claims arguments failed strict validation.");
    default:
      return invalid("Nested Pi requested an unknown coordinator tool.");
  }
};
