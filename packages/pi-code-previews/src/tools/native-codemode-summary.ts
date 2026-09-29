import {
  countLabel,
  failureMessage,
  formatCost,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
} from "pi-cosmic-core";
import type {
  CompactChild,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "./compact-summary";
import {
  nativeCodemodeEvidence,
  type NativeCallEvidence,
  type NativeCodemodeCall,
} from "./native-codemode-evidence";
import type { CompactIssue } from "./compact-issues";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { nativeArgumentPreview, safeNativeArgumentText } from "./native-codemode-args";
import { nativeCodemodeCallSubject } from "./native-codemode-subject";

function issue(code: string, text: string): CompactIssue {
  const detail = sanitizeDiagnosticContent(text);
  const message = failureMessage(detail, "The nested call failed");
  const projected: CompactIssue = { code, severity: "error", message };
  return detail === message ? projected : { ...projected, detail };
}

/** Native args are abbreviated JSON, never an execution receipt or complete argument record. */
function child(call: NativeCodemodeCall, phase: CompactPhase, cwd: string): CompactChild {
  const preview = nativeArgumentPreview(call.args);
  const target = nativeCodemodeCallSubject(call.name, preview, cwd);
  const entry: CompactChild = {
    label: sanitizeDiagnosticError(call.name, { maximumLength: 100 }),
    showTiming: true,
    ...target,
    subject: target.subject ? sanitizeDiagnosticError(target.subject, { maximumLength: 200 }) : "",
    // Native dispatch return remains semantically neutral, even with a completion checkmark.
    status:
      call.status === "ok"
        ? "returned"
        : phase === "settled" && call.status === "running"
          ? "uncertain"
          : call.status,
    issues: [
      ...(call.status === "error"
        ? [issue("native-child-error", call.error ?? "The nested call failed")]
        : []),
      ...(call.args
        ? [
            {
              code: "native-call-args",
              severity: "info" as const,
              message: "Arguments preview",
              detail:
                preview?.text ??
                (call.name === "models.classify"
                  ? safeNativeArgumentText(call.args)
                  : "Argument preview is unavailable"),
            },
          ]
        : []),
    ],
  };
  if (call.status === "ok") entry.returnedCheckmark = true;
  if (call.durationMs !== undefined) entry.durationMs = call.durationMs;
  if (call.cost !== undefined) entry.counters = [formatCost(call.cost)];
  return entry;
}

/** Expanded call evidence does not depend on recognizing an outer execution outcome. */
export function nativeCodemodeChildren(
  evidence: NativeCallEvidence,
  phase: CompactPhase,
  cwd: string,
): NonNullable<CompactSummary["children"]> {
  const calls = evidence.kind === "available" ? evidence.calls : [];
  return { entries: calls.map((call) => child(call, phase, cwd)), total: calls.length };
}

/** Only the factory's complete outer envelope is execution evidence, never guest output. */
export function nativeCodemodeHeader(
  result: Pick<AgentToolResult<unknown>, "content">,
): "completed" | "failed" | undefined {
  const first = result.content[0];
  if (first?.type !== "text") return undefined;
  const header =
    /^(Script completed|Script failed)\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/.exec(
      first.text,
    );
  return header ? (header[1] === "Script failed" ? "failed" : "completed") : undefined;
}

/**
 * Only the native outer header proves script completion, not success of nested operations.
 * Unknown headers decline; incomplete ledgers cannot prove success. Never sum parallel timings or parse
 * guest output as nested results.
 */
export const nativeCodemodeSummary =
  (cwd: string): CompactSummaryProvider<{ code: string }, unknown, any> =>
  ({ phase, result, context }) => {
    if (!result) return phase === "settled" ? undefined : { subject: "", showTiming: true };
    const evidence = nativeCodemodeEvidence(result.details);
    const calls = evidence.kind === "available" ? evidence.calls : [];
    const complete = evidence.kind === "available" && evidence.complete;
    const children = nativeCodemodeChildren(evidence, phase, cwd);
    const header = nativeCodemodeHeader(result);
    const output = result.content[1];
    // Native truncation replaces all text output with one envelope, even when its spill fails.
    // Recognizing this conservative warning never promotes guest output to an execution outcome.
    const truncatedEnvelope =
      !!header &&
      output?.type === "text" &&
      /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/.test(
        output.text,
      );
    const issues: CompactIssue[] = [];
    if (!complete)
      issues.push({
        code: "native-call-evidence-incomplete",
        severity: "warning",
        message:
          evidence.kind === "available"
            ? "Call details are incomplete"
            : "Call details are unavailable",
      });
    if (evidence.fullOutputPath || truncatedEnvelope) {
      const truncated: CompactIssue = {
        code: "native-output-truncated",
        severity: "warning",
        message: "Script output is truncated",
      };
      issues.push(
        evidence.fullOutputPath
          ? { ...truncated, detail: sanitizeDiagnosticContent(evidence.fullOutputPath) }
          : truncated,
      );
      if (!evidence.fullOutputPath && output?.type === "text") {
        const footer = "\n\n[Could not save the full output: ";
        const index = output.text.lastIndexOf(footer);
        if (index >= 0 && output.text.endsWith("]"))
          issues.push({
            code: "native-output-save-failed",
            severity: "warning",
            message: "Full script output could not be saved",
            detail: sanitizeDiagnosticContent(output.text.slice(index + footer.length, -1)),
          });
      }
    }
    const summary = {
      subject: "",
      showTiming: true as const,
      counters:
        evidence.kind === "unavailable"
          ? []
          : [
              complete
                ? countLabel(calls.length, "call")
                : `${countLabel(calls.length, "call")} listed`,
            ],
      children,
      issues,
    };
    if (phase !== "settled") return summary;
    if (!header) return undefined;
    const failed = header === "failed";
    if (failed) {
      // Native details do not expose a typed stop reason. Even a final native error block
      // can contain a guest-controlled Error.name/stack, so text cannot prove cancellation.
      const diagnostic =
        evidence.fullOutputPath || truncatedEnvelope
          ? undefined
          : result.content.findLast((part) => part.type === "text");
      const text =
        diagnostic?.type === "text" && diagnostic.text.startsWith("Script error:\n")
          ? diagnostic.text.slice("Script error:\n".length)
          : "";
      return {
        ...summary,
        outcome: "error",
        issues: [
          {
            ...issue("native-script-error", text || "The script failed"),
          },
          ...issues,
        ],
      };
    }
    // An error flag contradicting the completion header is not successful native execution.
    if (context.isError || result.isError)
      return {
        ...summary,
        outcome: "uncertain",
        issues: [
          {
            code: "native-outcome-uncertain",
            severity: "warning",
            message: "Script completion could not be confirmed",
          },
          ...issues,
        ],
      };
    if (!complete) return { ...summary, outcome: "uncertain" };
    if (calls.some((call) => call.status === "running" || call.status === "cancelled"))
      return {
        ...summary,
        outcome: "uncertain",
        issues: [
          {
            code: "native-call-outcome-uncertain",
            severity: "warning",
            message: "Some call outcomes are unconfirmed",
          },
          ...issues,
        ],
      };
    return {
      ...summary,
      outcome: calls.some((call) => call.status === "error") ? "warning" : "success",
    };
  };
