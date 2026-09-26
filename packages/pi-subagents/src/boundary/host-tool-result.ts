import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentToolName } from "../run/tool-policy.ts";
import { decodeSubagentOutcomeDetails, hasSubagentToolFailure } from "../tools/outcome.ts";

/** Pi marks resolved execute results as successful; receipts preserve their full evidence. */
export const registerSubagentErrorReceipts = (pi: ExtensionAPI) => {
  let activation: symbol | undefined;
  const receipts = new Map<
    string,
    { readonly tool: SubagentToolName; readonly details: unknown }
  >();
  const clear = (): void => receipts.clear();
  const apply = (event: ToolResultEvent): { readonly isError: true } | undefined => {
    const receipt = receipts.get(event.toolCallId);
    // Exact identity survives content middleware, but never blesses foreign/replaced details.
    if (!receipt || event.toolName !== receipt.tool || event.details !== receipt.details) return;
    receipts.delete(event.toolCallId);
    return { isError: true };
  };
  pi.on("tool_result", apply);
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
    retain: <DetailsInput>(
      owner: symbol,
      tool: SubagentToolName,
      callId: string,
      action: string,
      details: DetailsInput,
    ): void => {
      if (owner !== activation || callId.length > 1_024) return;
      const decoded = decodeSubagentOutcomeDetails(action, details);
      if (!decoded || !hasSubagentToolFailure(decoded)) return;
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
