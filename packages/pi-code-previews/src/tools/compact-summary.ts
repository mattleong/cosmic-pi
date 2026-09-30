import type { CompactIssue } from "./compact-issues";
import { compactIssueSeverity } from "./compact-issues";
import { isSafeCompactSummary } from "./compact-summary-schema";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { RendererState, ToolRenderContext } from "./renderers/shared/types";
import { failureMessage } from "pi-cosmic-core";

/** The registering session owns cancellation and shutdown. Undefined declines scheduling. */
export type CompactAnimationScheduler = (
  intervalMs: number,
  tick: () => void,
) => (() => void) | undefined;

export type CompactPhase = "pending" | "running" | "settled";
/**
 * `returned` is a neutral delivery outcome: the call settled without an error, but its
 * producer does not assert that the operation succeeded. Issues still raise its status.
 */
export type CompactOutcome =
  | "success"
  | "returned"
  | "warning"
  | "error"
  | "cancelled"
  | "uncertain";
export type CompactStatus = Exclude<CompactPhase, "settled"> | CompactOutcome;

/** One nested dispatch. `returned` confirms delivery, not semantic operation success. */
export interface CompactChild {
  label: string;
  action?: string;
  /** Argument-only target, laid out like a standalone compact call. Never output or recovery. */
  subject?: string;
  compactSubject?: string;
  counters?: readonly string[];
  metadata?: readonly string[];
  /** This call's own issues. The first error or warning is shown on its collapsed row. */
  issues?: readonly CompactIssue[];
  /** Measured dispatch duration, not an estimate or a sum of sibling timings. */
  durationMs?: number;
  status: CompactStatus;
  /** Confirm a completed dispatch with a neutral checkmark, without asserting operation success. */
  returnedCheckmark?: true;
  /** Keep measured duration beside this call’s routine detail, subject to timing policy. */
  showTiming?: true;
  /** Also display measured subsecond durations when global timing is enabled. */
  showShortTiming?: true;
}

/** Semantic display data, never inferred from a rendered component or Pi's success flag. */
export interface CompactSummary {
  subject: string;
  /** Human-facing target without internal identifiers; expansion retains subject. */
  compactSubject?: string;
  /** Operation not already identified by the tool name. Kept separate from target clipping. */
  action?: string;
  /** Alternatives for the single routine-detail slot, in priority order: the first that fits
   * is shown, so later entries are shorter fallbacks for narrow rows. Put warnings in issues.
   */
  counters?: readonly string[];
  /** First nonblank label is used only when no counter is present. */
  metadata?: readonly string[];
  /** Keep measured timing beside the routine detail instead of only when there is none. */
  showTiming?: true;
  /** Also display measured subsecond durations when global timing is enabled. */
  showShortTiming?: true;
  /** Required once settled. Children never change their parent's outcome. */
  outcome?: CompactOutcome;
  /** This operation's own issues in display order. Children carry theirs. */
  issues?: readonly CompactIssue[];
  /** Optional call tree in admission order. Total includes calls that are no longer retained. */
  children?: { entries: readonly CompactChild[]; total: number };
}

export type CompactSummaryProvider<
  TArgs = unknown,
  TDetails = unknown,
  TState = RendererState,
> = (input: {
  phase: CompactPhase;
  args: Partial<TArgs>;
  result: AgentToolResult<TDetails> | undefined;
  context: ToolRenderContext<TState, Partial<TArgs>>;
}) => CompactSummary | undefined;

/**
 * Validate provider output. A settled summary must classify its outcome. Pi's error flag
 * wins over a summary that claims success: the first line of the error text explains it.
 * An error is already explained by the summary's own error issue, or, when the summary
 * classifies its outcome as an error, by a child row's error issue.
 */
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
    (summary.children?.entries.some((child) => compactIssueSeverity(child.issues) === "error") ??
      false);
  if (compactIssueSeverity(summary.issues) === "error" || explainedByChild)
    return { ...summary, outcome: "error" };
  return {
    ...summary,
    outcome: "error",
    issues: [
      {
        severity: "error",
        code: "tool-error",
        message: failureMessage(errorText, "The tool reported an error"),
      },
      ...(summary.issues ?? []),
    ],
  };
}

/** Live lifecycle takes precedence over a premature success reported by a provider. */
export function compactStatus(phase: CompactPhase, summary: CompactSummary): CompactStatus {
  if (phase !== "settled") return phase;
  const severity = compactIssueSeverity(summary.issues);
  const outcome = summary.outcome ?? "uncertain";
  if (outcome === "cancelled" || outcome === "error") return outcome;
  if (severity === "error") return "error";
  if (outcome === "uncertain") return outcome;
  return severity ?? outcome;
}
