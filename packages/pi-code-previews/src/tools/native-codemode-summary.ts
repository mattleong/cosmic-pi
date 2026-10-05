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
import { selectCompactChildren } from "../preview/compact-children";
import { nativeArgumentPreview, safeNativeArgumentText } from "./native-codemode-args";
import { nativeCodemodeCallSubject } from "./native-codemode-subject";
import { nativeTruncationIssues, parseNativeTruncatedOutput } from "./native-truncation";
import {
  createNativeDiscoveryProjector,
  nativeDiscoveryLabel,
  type NativeDiscoveryProjector,
} from "./native-codemode-discovery";

/** Native model rows record only the `provider/id` they resolved, never prompts or image data. */
const nativeModelCalls: ReadonlySet<string> = new Set(["models.classify", "models.generateImages"]);
const SCRIPT_ERROR = "Script error:\n";

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
    ...target,
    label: sanitizeDiagnosticError(target.label ?? call.name, { maximumLength: 100 }),
    showTiming: true,
    showShortTiming: true,
    subject: target.subject ? sanitizeDiagnosticError(target.subject, { maximumLength: 200 }) : "",
    // Native dispatch return remains semantically neutral, even with a completion checkmark.
    status:
      call.status === "ok"
        ? "returned"
        : phase === "settled" && call.status === "running"
          ? "uncertain"
          : call.status,
    issues: [
      ...(target.label || call.name.startsWith("mcp__")
        ? [
            {
              code: "native-call-name",
              severity: "info" as const,
              message: "Registered tool",
              detail: sanitizeDiagnosticContent(call.name),
            },
          ]
        : []),
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
                (nativeModelCalls.has(call.name)
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
  (
    cwd: string,
    discovery: NativeDiscoveryProjector = createNativeDiscoveryProjector(),
  ): CompactSummaryProvider<{ code: string }, unknown, any> =>
  ({ phase, args, result, context }) => {
    const intent = discovery(args);
    const label = nativeDiscoveryLabel(intent);
    const heading = {
      subject: "",
      ...(label && { action: label }),
      showTiming: true as const,
      showShortTiming: true as const,
    };
    if (!result) return phase === "settled" ? undefined : heading;
    const evidence = nativeCodemodeEvidence(result.details);
    const calls = evidence.kind === "available" ? evidence.calls : [];
    const complete = evidence.kind === "available" && evidence.complete;
    const children = nativeCodemodeChildren(evidence, phase, cwd);
    const header = nativeCodemodeHeader(result);
    const output = result.content[1];
    // Native truncation replaces all text output with one envelope, even when its spill fails.
    // Recognizing this conservative warning never promotes guest output to an execution outcome.
    const truncatedEnvelope =
      header && output?.type === "text" ? parseNativeTruncatedOutput(output.text) : undefined;
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
    issues.push(
      ...nativeTruncationIssues(truncatedEnvelope, evidence.fullOutputPath, {
        code: "native",
        subject: "Script output",
      }),
    );
    const summary = {
      ...heading,
      counters:
        evidence.kind === "unavailable" || (complete && calls.length === 0 && intent?.discoveryOnly)
          ? []
          : [
              complete
                ? countLabel(
                    calls.length,
                    intent && calls.every((call) => !nativeModelCalls.has(call.name))
                      ? "tool call"
                      : "call",
                  )
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
      // Pi appends its error block after all guest output; only its own notes, such as one
      // about generated images the script never showed, may follow.
      const diagnostic =
        evidence.fullOutputPath || truncatedEnvelope
          ? undefined
          : result.content.findLast(
              (part) => part.type === "text" && part.text.startsWith(SCRIPT_ERROR),
            );
      const text = diagnostic?.type === "text" ? diagnostic.text.slice(SCRIPT_ERROR.length) : "";
      const failure = issue("native-script-error", text || "The script failed");
      // When a visible call stopped the program, its row already says why.
      const explained = selectCompactChildren(children).entries.some(
        (entry) =>
          entry.status === "error" &&
          entry.issues?.some(
            (cause) => cause.code === "native-child-error" && cause.message === failure.message,
          ),
      );
      return { ...summary, outcome: "error", issues: explained ? issues : [failure, ...issues] };
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
