import type { CompactIssue, CompactIssues, CompactSummary } from "pi-code-previews";
import type { McpCardDetails } from "./tool-render-details.ts";

/** Only fixed, validated boundary diagnostics enter this view. Remote messages stay
 * in the original raw details; unclassified notices keep their own attention. */
export function mcpBoundaryFailure(
  card: Pick<
    McpCardDetails,
    | "known"
    | "noticesComplete"
    | "displayCuts"
    | "isError"
    | "diagnostic"
    | "failureKind"
    | "failureReason"
    | "origin"
    | "outcome"
    | "action"
    | "truncated"
    | "recoveryHint"
    | "notices"
  >,
):
  | {
      readonly outcome: NonNullable<CompactSummary["outcome"]>;
      readonly status: string;
      readonly issues: CompactIssues;
    }
  | undefined {
  if (
    !card.known ||
    !card.noticesComplete ||
    card.displayCuts.length > 0 ||
    !card.isError ||
    !card.diagnostic ||
    !card.failureKind ||
    card.origin
  )
    return undefined;
  const uncertain = card.outcome === "unknown";
  const blocked =
    card.failureKind === "cleanup" ||
    card.failureReason === "oauth-mutation-unresolved" ||
    card.failureReason === "oauth-finalization-failed" ||
    card.failureReason === "oauth-deletion-failed";
  const recovery: Array<{ code: string; text: string }> = [];
  const diagnostics: string[] = [];
  // Uncertainty and resource/credential blockers must remain visible collapsed.
  // Routine explanations and navigation are available on expansion.
  if (uncertain || blocked)
    recovery.push({ code: "boundary-recovery", text: card.diagnostic.explanation });
  else diagnostics.push(card.diagnostic.explanation);
  if (uncertain && card.failureKind === "cleanup")
    recovery.push({
      code: "cleanup-gate",
      text: "Cleanup is unconfirmed. Reconnection is not safe recovery yet.",
    });
  if (card.truncated)
    recovery.push({
      code: "output-loss",
      text: "Output is unavailable or truncated. Do not replay to recover output.",
    });
  if (card.recoveryHint) diagnostics.push(card.recoveryHint);
  const entries: CompactIssue[] = [
    {
      operation: "mcp",
      code: "boundary-failure",
      // A validated boundary failure is separate from dispatch certainty.
      severity: !uncertain && card.failureKind === "cancelled" ? "warning" : "error",
      cause: uncertain
        ? ""
        : card.action === "result.read" &&
            (card.failureKind === "stale" || card.failureKind === "not-found")
          ? "Retained result unavailable."
          : card.diagnostic.title,
      recovery,
      diagnostics,
    },
  ];
  if (card.notices.length)
    entries.push({
      operation: "mcp",
      code: "unclassified-notices",
      severity: "warning",
      cause: card.notices.join("\n"),
      recovery: [],
    });
  return {
    outcome: uncertain ? "uncertain" : card.failureKind === "cancelled" ? "cancelled" : "error",
    status: uncertain
      ? "Outcome unknown"
      : card.outcome === "not-sent"
        ? "Not sent"
        : "Completed with a problem",
    issues: { coverage: "unknown", entries },
  };
}
