import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  MCP_CODE_MODE_MAX_INPUT_BYTES,
  MCP_CODE_MODE_MAX_OUTPUT_BYTES,
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  McpCodeModeInputSchema,
  McpCodeModeOutputSchema,
  mcpCodeModeError,
  mcpCodeModeHasBinary,
  mcpCodeModeJsonFits,
  mcpCodeModeOutcome,
  normalizeMcpCodeModeError,
  normalizeMcpCodeModeQuery,
  type McpCodeModeCapability,
} from "../code-mode/protocol.ts";

export const mcpCodeModeSessionId = (ctx: ExtensionContext): string | undefined =>
  invokeHostCallback(() => {
    const id = ctx.sessionManager?.getSessionId?.();
    return Predicate.isString(id) && id.length > 0 && id.length <= 1024 ? id : undefined;
  }, undefined);

export interface McpCodeModeActivation {
  readonly sessionId: string | undefined;
  readonly tokenCurrent: () => boolean;
  /** Live top-level mcp activation, not just package configuration. */
  readonly toolActive: () => boolean;
  readonly trusted: () => boolean;
  /**
   * Runs the shared gateway service on the existing host-owned session runtime.
   * Project with images:false and maxOutputBytes before copying retained results.
   * Reject with McpBoundaryError or McpCodeModeError to preserve execution certainty.
   */
  readonly execute: McpCodeModeCapability["execute"];
}

export interface McpCodeModeHost {
  readonly activate: (activation: McpCodeModeActivation) => void;
  readonly deactivate: () => void;
  readonly dispose: () => void;
}

/** The factory installs only a synchronous listener. It owns no runtime or MCP connection. */
export const makeMcpCodeModeHost = (events: ExtensionAPI["events"]): McpCodeModeHost => {
  let current:
    | { readonly capability: McpCodeModeCapability; readonly activation: McpCodeModeActivation }
    | undefined;
  let disposed = false;
  const active = (activation: McpCodeModeActivation): boolean =>
    invokeHostCallback(activation.tokenCurrent, false) &&
    invokeHostCallback(activation.toolActive, false) &&
    invokeHostCallback(activation.trusted, false);
  const deactivate = (): void => {
    current = undefined;
  };
  const unsubscribe = events.on(MCP_CODE_MODE_QUERY, (value) => {
    const query = normalizeMcpCodeModeQuery(value);
    const selected = current;
    if (
      !query ||
      !selected ||
      query.sessionId !== selected.capability.sessionId ||
      !active(selected.activation)
    )
      return;
    query.respond(selected.capability);
  });
  return {
    activate: (activation) => {
      deactivate();
      const sessionId = activation.sessionId;
      if (disposed || sessionId === undefined || sessionId.length === 0 || sessionId.length > 1024)
        return;
      const capability: McpCodeModeCapability = Object.freeze({
        version: MCP_CODE_MODE_VERSION,
        sessionId,
        execute: (
          callId: string,
          input: Parameters<McpCodeModeCapability["execute"]>[1],
          signal: AbortSignal,
          maxOutputBytes: number,
        ) =>
          Promise.resolve()
            .then(() => {
              const available = (): boolean =>
                current?.capability === capability && active(activation);
              if (!available()) throw mcpCodeModeError("unavailable", "not-sent");
              if (signal.aborted) throw mcpCodeModeError("cancelled", "not-sent");
              if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)
                throw mcpCodeModeError("invalid-input", "not-sent");
              if (!mcpCodeModeJsonFits(input, MCP_CODE_MODE_MAX_INPUT_BYTES))
                throw mcpCodeModeError("invalid-input", "not-sent");
              const decoded = Option.getOrUndefined(
                Schema.decodeUnknownOption(McpCodeModeInputSchema)(input),
              );
              if (!decoded) throw mcpCodeModeError("invalid-input", "not-sent");
              if (!available()) throw mcpCodeModeError("unavailable", "not-sent");
              const allowance = Math.min(maxOutputBytes, MCP_CODE_MODE_MAX_OUTPUT_BYTES);
              return activation.execute(callId, decoded, signal, allowance).then((output) => {
                // Revocation suppresses late publication even if a foreign callback ignores abort.
                const outcome = mcpCodeModeOutcome(output);
                if (!available()) throw mcpCodeModeError("stale", outcome);
                if (signal.aborted) throw mcpCodeModeError("cancelled", outcome);
                if (!mcpCodeModeJsonFits(output, allowance))
                  throw mcpCodeModeError("output-limit", outcome);
                const reply = Option.getOrUndefined(
                  Schema.decodeUnknownOption(Schema.fromJsonString(McpCodeModeOutputSchema))(
                    JSON.stringify(output),
                  ),
                );
                if (!reply || reply.action !== decoded.action || mcpCodeModeHasBinary(reply.data))
                  throw mcpCodeModeError("protocol", outcome);
                return reply;
              });
            })
            .catch((error) => {
              throw normalizeMcpCodeModeError(error);
            }),
      });
      current = Object.freeze({ activation, capability });
    },
    deactivate,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      deactivate();
      invokeHostCallback(unsubscribe, undefined);
    },
  };
};
