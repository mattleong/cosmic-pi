import * as Arr from "effect/Array";
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
  if (compactIssueSeverity(summary.issues) === "error" || explainedByChild)
    return { ...summary, outcome: "error" };
  return {
    ...summary,
    outcome: "error",
    issues: [toolErrorIssue(errorText), ...(summary.issues ?? [])],
  };
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
  if (phase !== "settled") return phase;
  const severity = compactIssueSeverity(summary.issues);
  const outcome = summary.outcome ?? "uncertain";
  if (outcome === "cancelled" || outcome === "error") return outcome;
  if (severity === "error") return "error";
  if (outcome === "uncertain") return outcome;
  return severity ?? outcome;
}
