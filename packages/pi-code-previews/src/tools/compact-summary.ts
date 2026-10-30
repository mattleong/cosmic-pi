import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { argumentFailureIssue } from "./argument-failure";
import { compactIssueSeverity, type CompactIssue } from "./compact-issues";
import { isSafeCompactSummary, type CompactOutcomeSchema } from "./compact-summary-schema";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "./renderers/shared/types";
import { failureMessage } from "pi-cosmic-core/message-text";

export type CompactAnimationScheduler = (
  intervalMs: number,
  tick: () => void,
) => (() => void) | undefined;

export type CompactPhase = "pending" | "running" | "settled";
export type CompactOutcome = typeof CompactOutcomeSchema.Type;
export type CompactStatus = Exclude<CompactPhase, "settled"> | CompactOutcome;

export interface CompactChild {
  label: string;
  action?: string;
  subject?: string;
  compactSubject?: string;
  counters?: readonly string[];
  metadata?: readonly string[];
  issues?: readonly CompactIssue[];
  durationMs?: number;
  status: CompactStatus;
  returnedCheckmark?: true;
  showTiming?: true;
  showShortTiming?: true;
}

export interface CompactSummary {
  subject: string;
  compactSubject?: string;
  action?: string;
  counters?: readonly string[];
  metadata?: readonly string[];
  showTiming?: true;
  showShortTiming?: true;
  outcome?: CompactOutcome;
  /**
   * A delivered message someone wrote: a successful or neutral heading shows which way it went
   * instead of its check or dot. Problems and attention keep their own icons.
   */
  messageIcon?: "sent" | "received";
  /** Words someone wrote, such as a sent message: a collapsed compact row shows them beneath it. */
  quote?: string;
  issues?: readonly CompactIssue[];
  children?: { entries: readonly CompactChild[]; total: number };
}

export type CompactSummaryProvider<
  TArgs = unknown,
  TDetails = unknown,
  TState = unknown,
> = (input: {
  phase: CompactPhase;
  args: Partial<TArgs>;
  result: AgentToolResult<TDetails> | undefined;
  context: ToolRenderContext<TState, Partial<TArgs>>;
}) => CompactSummary | undefined;

export function resolveCompactSummary(
  summary: CompactSummary | undefined,
  phase: CompactPhase,
  isError: boolean,
  errorText = "",
): CompactSummary | undefined {
  if (!summary || !isSafeCompactSummary(summary)) return undefined;
  if (phase === "settled" && summary.outcome === undefined) return undefined;
  if (!isError || summary.outcome === "cancelled" || summary.outcome === "uncertain")
    return summary;
  const explainedByChild =
    summary.outcome === "error" &&
    Arr.some(
      summary.children?.entries ?? [],
      (child) => compactIssueSeverity(child.issues) === "error",
    );
  const severity = compactIssueSeverity(summary.issues);
  if (severity === "error" || explainedByChild) return { ...summary, outcome: "error" };
  // The summary's own warning already explains the failure; a host issue would only repeat it.
  if (severity === "warning" && summary.issues)
    return { ...summary, outcome: "error", issues: withHostErrorDetail(summary.issues, errorText) };
  return {
    ...summary,
    outcome: "error",
    issues: [toolErrorIssue(errorText), ...(summary.issues ?? [])],
  };
}

// Keeps the host's error text in expansion once, on the first issue that explains the failure.
function withHostErrorDetail(
  issues: readonly CompactIssue[],
  errorText: string,
): readonly CompactIssue[] {
  const text = Str.trim(errorText);
  if (
    text === "" ||
    Arr.some(issues, (issue) => issue.detail !== undefined && Str.includes(text)(issue.detail))
  )
    return issues;
  const index = Arr.findFirstIndex(issues, (issue) => issue.severity === "warning");
  return Arr.map(issues, (issue, at) =>
    Option.contains(index, at)
      ? { ...issue, detail: issue.detail === undefined ? text : `${issue.detail}\n${text}` }
      : issue,
  );
}

export function toolErrorIssue(errorText: string): CompactIssue {
  return (
    argumentFailureIssue(errorText) ?? {
      severity: "error",
      code: "tool-error",
      message: failureMessage(errorText, "The tool reported an error"),
    }
  );
}

export function compactStatus(phase: CompactPhase, summary: CompactSummary): CompactStatus {
  return phase === "settled" ? compactSettledStatus(summary) : phase;
}

/** A settled summary's strongest signal from its outcome and issues. */
export function compactSettledStatus(summary: CompactSummary): CompactOutcome {
  const severity = compactIssueSeverity(summary.issues);
  const outcome = summary.outcome ?? "uncertain";
  if (outcome === "cancelled" || outcome === "error") return outcome;
  if (severity === "error") return "error";
  if (outcome === "uncertain" || outcome === "warning") return outcome;
  // Attention never outranks a warning, and outranks only routine outcomes.
  return severity ?? outcome;
}
