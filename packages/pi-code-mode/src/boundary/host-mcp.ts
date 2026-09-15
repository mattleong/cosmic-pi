import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MCP_CODE_MODE_MAX_INPUT_BYTES,
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  McpCodeModeInputSchema,
  McpCodeModeOutputSchema,
  mcpCodeModeError,
  mcpCodeModeHasBinary,
  mcpCodeModeJsonFits,
  mcpCodeModeOutcome,
  normalizeMcpCodeModeCapability,
  normalizeMcpCodeModeError,
  type McpCodeModeError,
  type McpCodeModeInput,
  type McpCodeModeOutput,
} from "pi-mcp/code-mode";
import { invokeHostCallback } from "pi-cosmic-core";
import { observeMcpReply, type McpObservation } from "../tools/mcp-evidence.ts";
import { toolError, type ToolError } from "./codemode-runtime.ts";

const decodeInput = Schema.decodeUnknownEffect(McpCodeModeInputSchema);
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(McpCodeModeOutputSchema));
export type McpDispatch = (input: McpCodeModeInput) => Effect.Effect<McpCodeModeOutput, ToolError>;

/** Only checked, bounded metadata enters the catchable message. Raw causes never enter the guest. */
const failure = (input: McpCodeModeInput, error: McpCodeModeError): ToolError =>
  toolError(
    JSON.stringify({
      outcome: error.outcome,
      kind: error.kind,
      action: input.action,
      server: "server" in input ? input.server : undefined,
      tool: "tool" in input ? input.tool : undefined,
      prompt: "prompt" in input ? input.prompt : undefined,
      id: "id" in input ? input.id : undefined,
      message: error.message,
    }),
  );

/** Re-query the explicit stable-session capability on every invocation, never a registered tool. */
export const makeMcpDispatch = (options: {
  readonly events: ExtensionAPI["events"];
  readonly sessionId: string | undefined;
  readonly toolCallId: string;
  readonly maxOutputBytes: () => number;
  readonly observe?: (observation: McpObservation) => void;
}): McpDispatch => {
  let nestedCalls = 0;
  return (input) =>
    Effect.suspend(() => {
      let observation: McpObservation = {
        outcome: "not-sent",
        isError: true,
        incomplete: false,
        notices: [],
      };
      const failed = (decoded: McpCodeModeInput, error: McpCodeModeError): ToolError => {
        observation = {
          outcome: error.outcome,
          isError: true,
          incomplete: false,
          notices: [error.message],
        };
        return failure(decoded, error);
      };
      const dispatch = Effect.suspend(() => {
        if (!mcpCodeModeJsonFits(input, MCP_CODE_MODE_MAX_INPUT_BYTES)) {
          return Effect.fail(
            toolError("MCP request exceeds the bounded JSON input contract; outcome=not-sent."),
          );
        }
        return decodeInput(input).pipe(
          Effect.mapError(() =>
            toolError("MCP request has an unsupported action or fields; outcome=not-sent."),
          ),
          Effect.flatMap((decoded) => {
            const sessionId = options.sessionId;
            if (sessionId === undefined)
              return Effect.fail(failed(decoded, mcpCodeModeError("unavailable", "not-sent")));
            const candidates: Array<
              NonNullable<ReturnType<typeof normalizeMcpCodeModeCapability>>
            > = [];
            let accepting = true;
            const emitted = invokeHostCallback(() => {
              options.events.emit(MCP_CODE_MODE_QUERY, {
                version: MCP_CODE_MODE_VERSION,
                sessionId,
                respond: <Candidate>(candidate: Candidate) => {
                  if (!accepting) return;
                  const normalized = normalizeMcpCodeModeCapability(candidate);
                  if (normalized?.sessionId === sessionId && candidates.length < 2)
                    candidates.push(normalized);
                },
              });
              return true;
            }, false);
            accepting = false;
            if (!emitted || candidates.length !== 1)
              return Effect.fail(failed(decoded, mcpCodeModeError("unavailable", "not-sent")));
            const capability = candidates[0]!;
            nestedCalls += 1;
            const callId = `${options.toolCallId}/mcp.request/${nestedCalls}`;
            const maxOutputBytes = options.maxOutputBytes();
            observation = { outcome: "unknown", isError: true, incomplete: false, notices: [] };
            return Effect.tryPromise((signal) =>
              capability.execute(callId, decoded, signal, maxOutputBytes),
            ).pipe(
              Effect.mapError((error) => failed(decoded, normalizeMcpCodeModeError(error.cause))),
              Effect.flatMap((output) => {
                const outcome = mcpCodeModeOutcome(output);
                if (!mcpCodeModeJsonFits(output, maxOutputBytes))
                  return Effect.fail(failed(decoded, mcpCodeModeError("output-limit", outcome)));
                return decodeOutput(JSON.stringify(output)).pipe(
                  Effect.mapError(() => failed(decoded, mcpCodeModeError("protocol", outcome))),
                  Effect.flatMap((reply) =>
                    reply.action === decoded.action &&
                    !mcpCodeModeHasBinary(reply.data, reply.action)
                      ? Effect.sync(() => {
                          observation = invokeHostCallback(() => observeMcpReply(reply), {
                            outcome: reply.outcome,
                            isError: reply.isError,
                            incomplete: true,
                            notices: [...reply.notices],
                          });
                          return reply;
                        })
                      : Effect.fail(failed(decoded, mcpCodeModeError("protocol", outcome))),
                  ),
                );
              }),
            );
          }),
        );
      });
      return dispatch.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure" && observation.isError === false)
              observation = { ...observation, isError: true };
            invokeHostCallback(() => options.observe?.(observation), undefined);
          }),
        ),
      );
    });
};
