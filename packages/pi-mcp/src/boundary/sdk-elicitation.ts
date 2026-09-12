import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isInputRequiredResult } from "@modelcontextprotocol/client";
import { boundaryError } from "../client/errors.ts";
import type { McpRequest } from "../client/model.ts";
import { MCP_INTERACTION_LIMITS, type McpExchange } from "../interaction/model.ts";
import { mcpCodeModeJsonFits } from "../code-mode/protocol.ts";
import { decodeMcpReply } from "./sdk-client.ts";

const InputRequired = Schema.Struct({
  resultType: Schema.Literal("input_required"),
  inputRequests: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)), Schema.Json),
  ),
  requestState: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MCP_INTERACTION_LIMITS.bytes)),
  ),
});

/** Strip wire-only state before any gateway retention or projection can inspect it. */
export const decodeSdkExchange = <Value>(
  action: McpRequest["action"],
  value: Value,
): Effect.Effect<McpExchange, import("../client/errors.ts").McpBoundaryError> =>
  Effect.gen(function* () {
    if (!isInputRequiredResult(value))
      return { kind: "complete", reply: yield* decodeMcpReply(action, value) };
    if (!mcpCodeModeJsonFits(value, 2 * MCP_INTERACTION_LIMITS.bytes))
      return yield* boundaryError("protocol", "unknown", "MCP input request exceeded its limit.");
    const input = yield* Schema.decodeUnknownEffect(InputRequired)(value).pipe(
      Effect.mapError(() => boundaryError("protocol", "unknown", "MCP input request was invalid.")),
    );
    if (
      (input.inputRequests === undefined && input.requestState === undefined) ||
      Object.keys(input.inputRequests ?? {}).length > MCP_INTERACTION_LIMITS.requests ||
      (input.requestState !== undefined &&
        new TextEncoder().encode(input.requestState).byteLength > MCP_INTERACTION_LIMITS.bytes) ||
      !mcpCodeModeJsonFits(input.inputRequests ?? {}, MCP_INTERACTION_LIMITS.bytes)
    )
      return yield* boundaryError("protocol", "unknown", "MCP input request exceeded its limit.");
    let exchange: McpExchange = { kind: "input-required" };
    if (input.inputRequests) exchange = { ...exchange, inputRequests: input.inputRequests };
    if (input.requestState !== undefined)
      exchange = { ...exchange, requestState: input.requestState };
    return exchange;
  });

export const terminalExchange = (exchange: McpExchange) =>
  exchange.kind === "complete"
    ? Effect.succeed(exchange.reply)
    : Effect.fail(
        boundaryError(
          "unsupported",
          "unknown",
          "MCP input requires an available owned user interaction.",
        ),
      );
