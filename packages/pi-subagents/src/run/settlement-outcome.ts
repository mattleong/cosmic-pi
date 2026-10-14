import { absurd } from "effect/Function";
import type { BackendAssistantTerminal } from "../backend/model.ts";
import {
  isInactiveRunRecord,
  type PendingInitializationSettlement,
  type RunRecord,
} from "./internal.ts";
import { isTerminalRunState, type SubagentRunView } from "./model.ts";

export type SettlementState = PendingInitializationSettlement["state"];

const terminalFailureMessage = (terminal?: BackendAssistantTerminal): string => {
  const stopReason = terminal?.stopReason;
  switch (stopReason) {
    case "error":
      return `Final provider error: ${(terminal?.errorMessage ?? "") || "provider returned no diagnostic"}`;
    case "aborted":
      return "Assignment aborted without a parent stop or correlated pause.";
    case "length":
      return "Assignment reached its output limit without a successful final report.";
    case "toolUse":
      return "Assignment settled after tool use without a final report.";
    case "stop":
    case undefined:
      return "Assignment settled without a successful nonempty final report.";
  }
  return absurd(stopReason);
};

export const settledAssignmentLocked = (
  record: RunRecord,
  assignmentEpoch: number,
  terminal: BackendAssistantTerminal | undefined,
): "ignored" | "buffered" | "running" => {
  if (
    record.assignment.epoch !== assignmentEpoch ||
    record.pausedAssignmentEpoch === assignmentEpoch ||
    record.assignment.phase === "preparing" ||
    record.assignment.phase === "reported" ||
    isInactiveRunRecord(record)
  )
    return "ignored";
  if (record.assignment.phase === "issuing") {
    record.assignment.pendingRunSettled = { terminal };
    return "buffered";
  }
  return "running";
};

const PARTIAL_OUTPUT_CHARS = 2_000;

// The failed attempt's own text, so the parent can judge the failure before retrying.
const partialOutput = (terminal: BackendAssistantTerminal | undefined): string => {
  const text = terminal?.text?.trim();
  if (!text) return "";
  const shown =
    text.length > PARTIAL_OUTPUT_CHARS ? `${text.slice(0, PARTIAL_OUTPUT_CHARS)}…` : text;
  return ` Partial output before the failure: ${shown}`;
};

export const settledFailureMessage = (terminal: BackendAssistantTerminal | undefined): string =>
  `${terminalFailureMessage(terminal)} Work and writes may already exist; inspect them before an explicit retry.${partialOutput(terminal)}`;

export const settlementBlocked = (record: RunRecord, state: SettlementState): boolean =>
  isTerminalRunState(record.view.state) ||
  (state !== "stopped" && (record.stoppedByParent || record.view.state === "stopping"));

export const viewForSettlement = (
  record: RunRecord,
  state: SettlementState,
  now: number,
  finalText: string | undefined,
  error: string | undefined,
): SubagentRunView => ({
  ...record.view,
  state,
  endedAt: now,
  lastActivityAt: now,
  currentTool: undefined,
  question: undefined,
  ...(record.view.steeringDelivery === "pending" && {
    steeringDelivery:
      state === "completed" ? ("report-unconfirmed" as const) : ("unresolved" as const),
  }),
  ...(state === "completed" && { reportGeneration: record.completionGeneration }),
  ...(finalText && { finalText }),
  ...(error !== undefined && { error }),
});
