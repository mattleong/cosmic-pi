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
  kind: "warning" | "error" | "recovery";
  text: string;
  /** The original expanded result renders this complete notice. Defaults to shell-owned.
   * Ignored for owned failures, collapsed views, or a failed original result renderer.
   */
  expandedInResult?: true;
}

/** Semantic display data, never inferred from a rendered component or Pi's success flag. */
export interface CompactSummary {
  subject: string;
  /** Operation not already identified by the tool name. Kept separate from target clipping. */
  action?: string;
  /** The first nonblank counter owns the single routine-detail slot. Combine related counts
   * into one label; put warnings and required recovery in notices, never later counters.
   */
  counters?: readonly string[];
  /** First nonblank label is used only when no counter is present. */
  metadata?: readonly string[];
  outcome?: CompactOutcome;
  notices?: readonly CompactNotice[];
  /** Opts decoded non-success results into compact collapsed presentation.
   * The provider must completely project attention and recovery information into
   * subject/notices. Expansion retains the original renderers; failure takes precedence.
   * Unknown or malformed results must decline compaction instead.
   */
  detailsOnExpand?: true;
  /** The original expanded result supplies the complete call heading and call information.
   * Only suppresses the call component when that result renderer succeeds. Sources, input
   * diffs, targets, and other unique call content must never be hidden through this flag.
   */
  expandedResultOwnsCall?: true;
  /** Owns failure presentation instead of the original renderers. Details must be complete.
   * Unknown causes may retain multiple lines rather than hide unclassified recovery text.
   * Notices contain independent safety/recovery information, not another error copy.
   */
  failure?: { cause: string; details: string };
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
  if (!summary || (phase === "settled" && summary.outcome === undefined)) return undefined;
  if (
    (isError && summary.outcome !== "cancelled" && summary.outcome !== "uncertain") ||
    summary.notices?.some((notice) => notice.kind === "error")
  )
    return { ...summary, outcome: "error" };
  return summary;
}

/** Live lifecycle takes precedence over a premature success reported by a provider. */
export function compactStatus(
  phase: CompactPhase,
  summary: CompactSummary,
): Exclude<CompactPhase, "settled"> | CompactOutcome {
  return phase === "settled" || compactSummaryNeedsDetails(summary)
    ? (summary.outcome ?? "uncertain")
    : phase;
}

/** Semantic non-success classification, independent of collapsed presentation opt-ins. */
export function compactSummaryNeedsDetails(summary: CompactSummary): boolean {
  return (
    summary.outcome === "error" ||
    summary.outcome === "cancelled" ||
    summary.outcome === "uncertain"
  );
}
