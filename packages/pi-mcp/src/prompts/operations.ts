import * as Effect from "effect/Effect";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpReply } from "../client/model.ts";
import type { McpOperation } from "../connection/model.ts";
import type { McpDiscoveryContract } from "../discovery/model.ts";
import type { McpGatewayRequest } from "../tools/model.ts";

/** Prompt messages and roles remain result data, never host conversation messages. */
export const getPrompt = (
  operation: McpOperation,
  input: Extract<McpGatewayRequest, { readonly action: "prompts.get" }>,
  discovery: McpDiscoveryContract,
): Effect.Effect<McpReply, McpBoundaryError> =>
  Effect.gen(function* () {
    yield* operation.checkCurrent;
    if (!operation.capabilities.prompts) {
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "MCP server does not advertise prompts.",
      );
    }
    const snapshot = yield* discovery.ensure(operation);
    yield* operation.checkCurrent;
    const prompt = snapshot.prompts.find((candidate) => candidate.name === input.prompt);
    if (!prompt)
      return yield* boundaryError("not-found", "not-sent", "MCP prompt was not advertised.");
    const arguments_ = input.arguments ?? {};
    const declared = prompt.arguments ?? [];
    const names = new Set(declared.map((argument) => argument.name));
    if (
      Object.keys(arguments_).some((key) => !names.has(key)) ||
      declared.some((argument) => argument.required && !Object.hasOwn(arguments_, argument.name))
    )
      return yield* boundaryError(
        "invalid-input",
        "not-sent",
        "MCP prompt arguments do not match its metadata.",
      );
    yield* operation.checkCurrent;
    return yield* operation.request({
      action: "prompts.get",
      prompt: input.prompt,
      arguments: arguments_,
    });
  });
