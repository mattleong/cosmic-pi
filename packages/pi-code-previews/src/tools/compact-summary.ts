import type { CompactIssues, CompactIssueClaim } from "./compact-issues";
import {
  compactIssueSeverity,
  summaryCompactIssues,
  legacyCompactIssues,
  claimCompactIssue,
} from "./compact-issues";
import { isSafeCompactSummary } from "./compact-summary-schema";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { RendererState, ToolRenderContext } from "./renderers/shared/types";

/** The registering session owns cancellation and shutdown. Undefined declines scheduling. */
export type CompactAnimationScheduler = (
  intervalMs: number,
  tick: () => void,
) => (() => void) | undefined;

export type CompactPhase = "pending" | "running" | "settled";
export type CompactOutcome = "success" | "warning" | "error" | "cancelled" | "uncertain";

export interface CompactNotice {
  /** Producer-owned identity within this operation. Absent on unclassified history. */
  code?: string;
  kind: "warning" | "error" | "recovery";
  text: string;
  /** Informational recovery shown only on expansion. Ignored for warnings and errors. */
  expandedOnly?: true;
}

/** Warnings and errors always require attention, even if marked expanded-only. */
export function isCompactAttention(notice: CompactNotice): boolean {
  return notice.kind !== "recovery" || notice.expandedOnly !== true;
}

/** One nested dispatch. `returned` confirms delivery, not semantic operation success. */
export interface CompactChild {
  issues?: CompactIssues;
  failureEvidence?: CompactFailureEvidence;
  label: string;
  action?: string;
  counters?: readonly string[];
  metadata?: readonly string[];
  showTiming?: true;
  outcome?: CompactOutcome;
  /** Bounded semantic notices; callers retain attention separately from row selection. */
  notices?: readonly CompactNotice[];
  /** Argument-only target, laid out like a standalone compact call. Never output or recovery. */
  subject?: string;
  /** Measured dispatch duration, not an estimate or a sum of sibling timings. */
  durationMs?: number;
  status: "pending" | "running" | "returned" | CompactOutcome;
}

/** Producer-authored semantic explanation. Never an arbitrary diagnostic body. */
export interface CompactFailureEvidence {
  readonly code: string;
  readonly cause: string;
  readonly coverage: "complete" | "unknown";
}

/** Semantic display data, never inferred from a rendered component or Pi's success flag. */
export interface CompactSummary {
  issues?: CompactIssues;
  subject: string;
  /** Operation not already identified by the tool name. Kept separate from target clipping. */
  action?: string;
  /** The first nonblank counter owns the single routine-detail slot. Combine related counts
   * into one label; put warnings and required recovery in notices, never later counters.
   */
  counters?: readonly string[];
  /** First nonblank label is used only when no counter is present. */
  metadata?: readonly string[];
  /** Show measured timing beside the routine detail, including short calls, when enabled. */
  showTiming?: true;
  outcome?: CompactOutcome;
  notices?: readonly CompactNotice[];
  /** Optional collapsed-only call tree in admission order. Total includes unretained calls.
   * The shell bounds displayed rows; warnings and recovery must remain in notices.
   */
  children?: { entries: readonly CompactChild[]; total: number };
  /** Legacy provider marker for details available on expansion. All collapsed outcomes
   * use compact rows regardless of this flag. Expansion prefers content-only callbacks;
   * a covered failure owns only its diagnostic body. Unknown or malformed results must decline
   * semantic projection and use the shell's generic compact row.
   */
  detailsOnExpand?: true;
  /** The original expanded result supplies the complete call heading and call information.
   * Only suppresses the call component when that result renderer succeeds. Sources, input
   * diffs, targets, and other unique call content must never be hidden through this flag.
   */
  expandedResultOwnsCall?: true;
  /** Exact fields rendered by the current expanded result; revoked on rendering failure. */
  expandedResultOwnsIssues?: readonly CompactIssueClaim[];
  /** Owns the failure diagnostic body. Unique expanded call content remains. Details must be complete.
   * Unknown causes may retain multiple lines rather than hide unclassified recovery text.
   * Notices contain independent safety/recovery information, not another error copy.
   */
  failure?: {
    cause: string;
    details: string;
    /** Snapshot fields represented by this exact failure body. */
    ownedIssues?: readonly CompactIssueClaim[];
  };
  failureEvidence?: CompactFailureEvidence;
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

/** A settled summary must explicitly classify the domain outcome. */
export function resolveCompactSummary(
  summary: CompactSummary | undefined,
  phase: CompactPhase,
  isError: boolean,
): CompactSummary | undefined {
  if (
    !summary ||
    !isSafeCompactSummary(summary) ||
    (phase === "settled" && summary.outcome === undefined)
  )
    return undefined;
  if (
    isError &&
    summary.outcome !== "cancelled" &&
    !summary.issues?.entries.some((issue) => issue.severity === "error")
  ) {
    const issues =
      summary.issues ??
      legacyCompactIssues(
        [
          ...(summary.notices ?? []),
          ...(summary.outcome === "uncertain"
            ? [{ kind: "warning" as const, text: "Execution outcome is uncertain." }]
            : []),
        ],
        "outer",
      );
    const hostFailure = {
      operation: "outer",
      code: "pi-error",
      severity: "error" as const,
      cause: summary.failure?.cause || "Tool reported a failure.",
      recovery: [],
    };
    return {
      ...summary,
      ...(summary.failure && {
        failure: {
          ...summary.failure,
          ownedIssues: [
            ...(summary.failure.ownedIssues ?? []),
            claimCompactIssue(hostFailure, { cause: true }),
          ],
        },
      }),
      issues: {
        ...issues,
        coverage: summary.issues?.coverage ?? "complete",
        entries: [
          ...issues.entries,
          ...(summary.outcome === "uncertain" && summary.issues
            ? [
                {
                  operation: "outer",
                  code: "execution-uncertain",
                  severity: "warning" as const,
                  cause: "Execution outcome is uncertain.",
                  recovery: [],
                },
              ]
            : []),
          hostFailure,
        ],
      },
    };
  }
  return summary;
}

/** Live lifecycle takes precedence over a premature success reported by a provider. */
export function compactStatus(
  phase: CompactPhase,
  summary: CompactSummary,
): Exclude<CompactPhase, "settled"> | CompactOutcome {
  return phase === "settled" || compactSummaryNeedsDetails(summary)
    ? summary.outcome === "error"
      ? "error"
      : (compactIssueSeverity(summaryCompactIssues(summary)) ?? summary.outcome ?? "uncertain")
    : phase;
}

/** Semantic non-success classification, independent of collapsed presentation opt-ins. */
export function compactSummaryNeedsDetails(summary: CompactSummary): boolean {
  return (
    compactIssueSeverity(summaryCompactIssues(summary)) === "error" ||
    summary.outcome === "error" ||
    summary.outcome === "cancelled" ||
    summary.outcome === "uncertain"
  );
}
