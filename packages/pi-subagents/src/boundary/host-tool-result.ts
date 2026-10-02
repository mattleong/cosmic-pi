import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { SUBAGENT_TOOL_NAMES, type SubagentToolName } from "../run/tool-policy.ts";
import { decodeSubagentOutcomeDetails, marksSubagentToolError } from "../tools/outcome.ts";

/**
 * Pi marks resolved execute results as successful; receipts preserve their full evidence. Typed
 * pending guidance delivery is not an error, but any other target-operation failure in the same
 * result still marks the call.
 */
export const registerSubagentErrorReceipts = (pi: ExtensionAPI) => {
  let activation: symbol | undefined;
  const receipts = new Map<
    string,
    { readonly tool: SubagentToolName; readonly details: unknown }
  >();
  const calls = new Map<string, "pending" | "model" | "script">();
  const ownedNames = new Set<string>(SUBAGENT_TOOL_NAMES);
  const clear = (): void => {
    receipts.clear();
    calls.clear();
  };
  // Start preserves an empty parent ID even when Pi omits it from the later tool_call.
  // Both observations must agree before granting model origin; script evidence stays sticky.
  pi.on("tool_execution_start", (event) => {
    if (!activation || !ownedNames.has(event.toolName)) return;
    const known = calls.get(event.toolCallId);
    if (event.toolCallId.length > 1_024 || (known === undefined && calls.size >= 256)) return;
    if (event.parentToolCallId !== undefined) calls.set(event.toolCallId, "script");
    else if (known === undefined) calls.set(event.toolCallId, "pending");
  });
  // Only native host provenance identifies origin; arguments and ID spelling do not.
  pi.on("tool_call", (event) => {
    if (!activation || !ownedNames.has(event.toolName)) return;
    const known = calls.get(event.toolCallId);
    if (event.toolCallId.length > 1_024 || (known === undefined && calls.size >= 256))
      return { block: true, reason: "Too many active subagent calls" };
    calls.set(
      event.toolCallId,
      event.parentToolCallId === undefined && known === "pending" ? "model" : "script",
    );
    return undefined;
  });
  const apply = (event: ToolResultEvent): { readonly isError: true } | undefined => {
    calls.delete(event.toolCallId);
    const receipt = receipts.get(event.toolCallId);
    // Exact identity survives content middleware, but never blesses foreign/replaced details.
    if (!receipt || event.toolName !== receipt.tool || event.details !== receipt.details) return;
    receipts.delete(event.toolCallId);
    return { isError: true };
  };
  pi.on("tool_result", apply);
  // Native nested calls always emit end, even when abort or another hook skips tool_result.
  pi.on("tool_execution_end", (event) => {
    calls.delete(event.toolCallId);
  });
  pi.on("agent_end", clear);
  return {
    activate: (): symbol => {
      activation = Symbol("subagent-tool-results");
      clear();
      return activation;
    },
    deactivate: (): void => {
      activation = undefined;
      clear();
    },
    isNested: (owner: symbol, callId: string): boolean =>
      owner !== activation || calls.get(callId) !== "model",
    retain: <DetailsInput>(
      owner: symbol,
      tool: SubagentToolName,
      callId: string,
      action: string,
      details: DetailsInput,
    ): void => {
      if (owner !== activation || callId.length > 1_024) return;
      const decoded = decodeSubagentOutcomeDetails(action, details);
      if (!decoded || !marksSubagentToolError(decoded)) return;
      // Bound the original identity too: decoders intentionally ignore unknown fields.
      try {
        if (JSON.stringify(details).length > MAX_TOOL_OUTPUT_CHARS) return;
      } catch {
        return;
      }
      receipts.delete(callId);
      if (receipts.size >= 256) {
        const oldest = receipts.keys().next().value;
        if (oldest !== undefined) receipts.delete(oldest);
      }
      receipts.set(callId, { tool, details });
    },
  };
};

export interface SubagentErrorReceiptOwner {
  readonly owner: symbol;
  readonly receipts: ReturnType<typeof registerSubagentErrorReceipts>;
}
