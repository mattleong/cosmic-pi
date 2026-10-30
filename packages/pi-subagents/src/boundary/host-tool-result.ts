import type {
  AgentToolResult,
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { ROOT_TOOL_NAMES, type AgentToolName, type SubagentToolName } from "../run/tool-policy.ts";
import type { ToolFailureDetails } from "../tools/details-schema.ts";
import { toolFailureDetails } from "../tools/failure-details.ts";
import { decodeSubagentOutcomeDetails, hasSubagentToolFailure } from "../tools/outcome.ts";

const MAX_RETAINED_RESULTS = 256;

/** Keeps at most `MAX_RETAINED_RESULTS` entries, dropping the oldest first. */
const setBounded = <V>(map: Map<string, V>, key: string, value: V): void => {
  map.delete(key);
  if (map.size >= MAX_RETAINED_RESULTS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
};

export const registerSubagentErrorReceipts = (pi: ExtensionAPI) => {
  let activation: symbol | undefined;
  const receipts = new Map<
    string,
    { readonly tool: SubagentToolName; readonly details: unknown }
  >();
  // Pi keeps only a thrown error's text; its user copy reaches the result as details.
  const failures = new Map<
    string,
    { readonly tool: SubagentToolName | AgentToolName; readonly details: ToolFailureDetails }
  >();
  const calls = new Map<string, "pending" | "model" | "script">();
  const ownedNames = new Set<string>(ROOT_TOOL_NAMES);
  const clear = (): void => {
    receipts.clear();
    failures.clear();
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
  const apply = (event: ToolResultEvent): ToolResultEventResult | undefined => {
    calls.delete(event.toolCallId);
    const failure = failures.get(event.toolCallId);
    failures.delete(event.toolCallId);
    if (failure && event.isError && event.toolName === failure.tool)
      return { details: failure.details };
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
      if (!decoded || !hasSubagentToolFailure(decoded)) return;
      const { details } = result;
      try {
        if (JSON.stringify(details).length > MAX_TOOL_OUTPUT_CHARS) return;
      } catch {
        return;
      }
      setBounded(receipts, callId, { tool, details });
    },
    /** Records a rejected call's failure, which its error result then carries as details. */
    retainFailure: (
      owner: symbol,
      tool: SubagentToolName | AgentToolName,
      callId: string,
      cause: unknown,
    ): void => {
      if (owner !== activation || callId.length > 1_024) return;
      const details = toolFailureDetails(cause);
      if (details) setBounded(failures, callId, { tool, details });
    },
  };
};

export interface SubagentErrorReceiptOwner {
  readonly owner: symbol;
  readonly receipts: ReturnType<typeof registerSubagentErrorReceipts>;
}
