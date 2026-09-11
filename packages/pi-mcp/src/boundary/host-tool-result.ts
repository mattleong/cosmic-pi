import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { McpBoundaryError } from "../client/errors.ts";
import { mcpDiagnostic } from "../client/diagnostics.ts";
import { MCP_INLINE_BYTES, type McpGatewayReply } from "../tools/model.ts";

export type McpActivationMarker = symbol;

/** Error receipts contain only already bounded details, never a retained server payload. */
export const makeMcpErrorReceipts = () => {
  let activation: McpActivationMarker | undefined;
  const receipts = new Map<
    string,
    { readonly activation: McpActivationMarker; readonly details: McpGatewayReply }
  >();
  return {
    activate: (owner: McpActivationMarker): void => {
      activation = owner;
      receipts.clear();
    },
    clear: (): void => {
      receipts.clear();
    },
    deactivate: (): void => {
      activation = undefined;
      receipts.clear();
    },
    retain: (callId: string, owner: McpActivationMarker, details: McpGatewayReply): void => {
      if (owner !== activation || !details.isError || callId.length > 1_024) return;
      receipts.delete(callId);
      // Bounded even when a host never emits tool_result or end-of-turn events.
      if (receipts.size >= 256) {
        const oldest = receipts.keys().next().value;
        if (oldest !== undefined) receipts.delete(oldest);
      }
      receipts.set(callId, { activation: owner, details });
    },
    apply: (event: ToolResultEvent): { readonly isError: true } | undefined => {
      if (event.toolName !== "mcp") return;
      const receipt = receipts.get(event.toolCallId);
      // The details identity proves this is the result returned by our execute, not a
      // foreign or stale tool that happens to reuse a call id. Earlier content patches survive.
      if (!receipt || receipt.activation !== activation || event.details !== receipt.details)
        return;
      receipts.delete(event.toolCallId);
      return { isError: true };
    },
  };
};
export type McpErrorReceipts = ReturnType<typeof makeMcpErrorReceipts>;

/** Public diagnostics are fixed by reason, never copied from exception messages. */
const failureMessage = (error: McpBoundaryError): string => {
  switch (error.reason) {
    case "oauth-resource-metadata-missing":
      return "OAuth protected-resource metadata is missing. Compatibility requires auth.allowMissingResourceMetadata: true and an explicit auth.issuer.";
    case "oauth-resource-metadata-invalid":
      return "OAuth protected-resource discovery failed. Missing-metadata compatibility cannot bypass invalid metadata or unexpected HTTP responses.";
    default:
      return mcpDiagnostic(error).explanation;
  }
};

export const promptArgumentHint = (action: string, error: McpBoundaryError): string | undefined =>
  action === "prompts.get" &&
  error.kind === "invalid-input" &&
  error.outcome === "not-sent" &&
  error.reason === undefined
    ? "Call prompts.list on the same server to inspect the prompt's declared arguments."
    : undefined;

export const mcpFailureReply = (action: string, error: McpBoundaryError): McpGatewayReply => {
  const diagnostic = { kind: error.kind, message: failureMessage(error) };
  const hint = promptArgumentHint(action, error);
  return {
    action,
    outcome: error.outcome,
    isError: true,
    data: error.reason === undefined ? diagnostic : { ...diagnostic, reason: error.reason },
    notices:
      error.outcome === "unknown"
        ? ["Execution may have completed. Do not replay this operation automatically."]
        : hint === undefined
          ? []
          : [hint],
  };
};

/** Last-resort protection for host display and details; projection normally enforces this first. */
export const boundedMcpReply = (reply: McpGatewayReply): McpGatewayReply => {
  const encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded, "utf8") <= MCP_INLINE_BYTES) return reply;
  const limited: McpGatewayReply = {
    action: reply.action,
    outcome: reply.outcome,
    isError: true,
    data: { kind: "output-limit", message: "MCP output exceeded the inline allowance." },
    notices: [
      reply.resultId === undefined
        ? "The output is not recoverable."
        : "Use result.read to retrieve bounded pages.",
    ],
  };
  return reply.resultId === undefined ? limited : { ...limited, resultId: reply.resultId };
};
