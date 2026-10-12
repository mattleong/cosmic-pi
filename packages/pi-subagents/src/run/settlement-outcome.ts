import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MAX_BACKEND_REPORT_TEXT_CHARS, type BackendAssistantTerminal } from "../backend/model.ts";
import { canonicalResultJson, decodeResultText } from "../domain/result-contract.ts";
import { processError } from "./errors.ts";
import {
  isInactiveRunRecord,
  type PendingInitializationSettlement,
  type RunRecord,
} from "./internal.ts";
import { isTerminalRunState, type SubagentRunView } from "./model.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeOutputText } from "./state.ts";

export type SettlementState = PendingInitializationSettlement["state"];

const terminalFailureMessage = (terminal?: BackendAssistantTerminal): string => {
  switch (terminal?.stopReason) {
    case "error":
      return `Final provider error: ${(terminal.errorMessage ?? "") || "provider returned no diagnostic"}`;
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
};

export const acceptedResult = (record: RunRecord, assignmentEpoch: number): string | undefined =>
  record.structuredResult?.assignmentEpoch === assignmentEpoch
    ? record.structuredResult.json
    : undefined;

export const settledAssignmentLocked = (
  record: RunRecord,
  assignmentEpoch: number,
  terminal: BackendAssistantTerminal | undefined,
): "ignored" | "buffered" | "running" => {
  if (
    record.assignment.epoch !== assignmentEpoch ||
    (record.pausedAssignmentEpoch === assignmentEpoch &&
      acceptedResult(record, assignmentEpoch) === undefined) ||
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

export const settledText = (record: RunRecord, terminal?: BackendAssistantTerminal) =>
  Effect.gen(function* () {
    const text =
      terminal?.stopReason === "stop" && terminal.text
        ? sanitizeOutputText(terminal.text, MAX_BACKEND_REPORT_TEXT_CHARS).trim()
        : undefined;
    const contract = record.launch.resultContract;
    if (!contract || !text) return { text, problem: undefined };
    const decoded = yield* Effect.result(decodeResultText(contract, text));
    return Result.isSuccess(decoded)
      ? { text: canonicalResultJson(decoded.success), problem: undefined }
      : { text: undefined, problem: decoded.failure.message };
  });

export const settledFailureMessage = (
  record: RunRecord,
  terminal: BackendAssistantTerminal | undefined,
  problem: string | undefined,
): string => {
  const reason =
    record.launch.resultContract && terminal?.stopReason === "stop"
      ? problem
        ? `Assignment finished without submitting its structured result, and its final text is not a valid result: ${problem}`
        : "Assignment finished without submitting its structured result."
      : terminalFailureMessage(terminal);
  return `${reason} Work and writes may already exist; inspect them before an explicit retry.`;
};

export const reportFinalText = (record: RunRecord, text: string) => {
  const contract = record.launch.resultContract;
  if (!contract)
    return Effect.succeed(sanitizeOutputText(text, MAX_BACKEND_REPORT_TEXT_CHARS).trim());
  return decodeResultText(contract, text).pipe(
    Effect.mapBoth({
      onFailure: (error) =>
        processError(
          "accept report from",
          "backend_report_schema_invalid",
          sanitizeDiagnosticText(
            `Subagent ${record.view.id} reported a result that does not match its schema: ${error.message}`,
            MAX_ERROR_CHARS,
          ),
        ),
      onSuccess: canonicalResultJson,
    }),
  );
};

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
