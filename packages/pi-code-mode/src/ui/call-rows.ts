/** Shared receipt projection for collapsed and expanded nested calls. */
import type { CompactChild, CompactIssue, CompactPhase } from "pi-code-previews";
import { isCompactPiTool, nestedToolLabel } from "../tools/compact-subject.ts";
import type { CodeModeCallEntry } from "../tools/format.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

const label = (call: CodeModeCallEntry): string =>
  nestedToolLabel(call.tool, call.compact !== undefined);

const status = (
  call: CodeModeCallEntry,
  phase: CompactPhase,
  details: CodeModeRenderDetails,
): CompactChild["status"] => {
  // Delivery failure takes precedence over a successful operation receipt.
  if (call.compact?.deliveryFailed)
    return call.compact.outcome === "uncertain" ? "uncertain" : "error";
  if (call.status === "error" && call.compact?.outcome === "uncertain") return "uncertain";
  if (call.status === "completed")
    return (
      call.compact?.outcome ??
      (isCompactPiTool(call.tool) && details.compactAttention === undefined
        ? "success"
        : "returned")
    );
  if (call.status === "queued" || call.status === "running")
    return phase === "settled" ? "uncertain" : call.status === "queued" ? "pending" : "running";
  return call.status;
};

/** Calls that never settled say so on their own row once the run has ended. */
const unsettledIssue = (call: CodeModeCallEntry, phase: CompactPhase): CompactIssue[] =>
  phase !== "settled"
    ? []
    : call.status === "queued"
      ? [{ severity: "warning", code: "not-started", message: "Did not start" }]
      : call.status === "running"
        ? [{ severity: "warning", code: "unsettled", message: "May still be running" }]
        : [];

export const codeModeCallRows = (
  details: CodeModeRenderDetails,
  phase: CompactPhase,
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): CompactChild[] =>
  details.toolCalls.map((call): CompactChild => {
    const durationMs =
      call.status === "running"
        ? phase === "running"
          ? liveElapsed?.(call)
          : undefined
        : call.status === "queued"
          ? undefined
          : call.durationMs;
    const issues = [...(call.compact?.issues ?? []), ...unsettledIssue(call, phase)];
    return {
      label: label(call),
      ...(call.subject !== undefined && { subject: call.subject }),
      ...(call.compact !== undefined && {
        subject: call.compact.subject,
        ...(call.compact.compactSubject !== undefined && {
          compactSubject: call.compact.compactSubject,
        }),
        ...(call.compact.action !== undefined && { action: call.compact.action }),
        ...(call.compact.counters !== undefined && { counters: call.compact.counters }),
        ...(call.compact.metadata !== undefined && { metadata: call.compact.metadata }),
      }),
      ...(issues.length > 0 && { issues }),
      ...(durationMs !== undefined && { durationMs }),
      status: status(call, phase, details),
    };
  });
