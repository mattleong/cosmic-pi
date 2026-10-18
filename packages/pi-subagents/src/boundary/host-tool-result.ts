import type {
  AgentToolResult,
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { ROOT_TOOL_NAMES, type SubagentToolName } from "../run/tool-policy.ts";
import { decodeSubagentOutcomeDetails, marksSubagentToolError } from "../tools/outcome.ts";

export const registerSubagentErrorReceipts = (pi: ExtensionAPI) => {
  let activation: symbol | undefined;
  const receipts = new Map<
    string,
    { readonly tool: SubagentToolName; readonly details: unknown }
  >();
  const calls = new Map<string, "pending" | "model" | "script">();
  const ownedNames = new Set<string>(ROOT_TOOL_NAMES);
  const clear = (): void => {
    receipts.clear();
    calls.clear();
  };
  pi.on("tool_execution_start", (event) => {
    if (!activation || !ownedNames.has(event.toolName)) return;
    const known = calls.get(event.toolCallId);
    if (event.toolCallId.length > 1_024 || (known === undefined && calls.size >= 256)) return;
    if (event.parentToolCallId !== undefined) calls.set(event.toolCallId, "script");
    else if (known === undefined) calls.set(event.toolCallId, "pending");
  });
  pi.on("tool_call", (event) => {
    if (!activation || !ownedNames.has(event.toolName)) return undefined;
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
    if (!receipt || event.toolName !== receipt.tool || event.details !== receipt.details)
      return undefined;
    receipts.delete(event.toolCallId);
    return { isError: true };
  };
  pi.on("tool_result", apply);
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
    retain: (
      owner: symbol,
      tool: SubagentToolName,
      callId: string,
      action: string,
      result: AgentToolResult<unknown>,
    ): void => {
      if (owner !== activation || callId.length > 1_024) return;
      const decoded = decodeSubagentOutcomeDetails(action, result);
      if (!decoded || !marksSubagentToolError(decoded)) return;
      const { details } = result;
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
