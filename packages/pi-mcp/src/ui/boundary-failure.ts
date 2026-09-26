import { mcpBoundaryDescriptions, mcpIssueMessages } from "./compact-descriptions.ts";
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import type { McpDiagnostic } from "../client/diagnostics.ts";
import type { McpBoundaryError } from "../client/errors.ts";

export interface McpBoundaryView {
  readonly outcome: NonNullable<CompactSummary["outcome"]>;
  readonly status: string;
  readonly issues: readonly CompactIssue[];
}

export const credentialMutationBlocked = (reason: McpBoundaryError["reason"]): boolean =>
  reason === "oauth-mutation-unresolved" ||
  reason === "oauth-finalization-failed" ||
  reason === "oauth-deletion-failed";

/** Only fixed, validated boundary diagnostics enter this view. Remote messages stay
 * in the original raw details; unclassified notices keep their own issue.
 * Callers own the gates that decide whether it replaces the detailed layout. */
export function mcpBoundaryView(input: {
  readonly diagnostic: McpDiagnostic;
  readonly failure: Pick<McpBoundaryError, "kind" | "reason">;
  readonly outcome: "completed" | "unknown" | "not-sent";
  readonly action: string;
  readonly truncated: boolean;
  readonly notices: readonly string[];
  readonly recoveryHint?: string;
}): McpBoundaryView {
  const { kind, reason } = input.failure;
  const uncertain = input.outcome === "unknown";
  const retainedMissing =
    input.action === "result.read" && (kind === "stale" || kind === "not-found");
  const issues: CompactIssue[] = [
    {
      // A validated boundary failure is separate from dispatch certainty.
      severity: !uncertain && kind === "cancelled" ? "warning" : "error",
      code: "boundary-failure",
      message: uncertain
        ? mcpIssueMessages["execution-unknown"]
        : retainedMissing
          ? "Saved output is not available"
          : mcpBoundaryDescriptions[kind],
      detail: [
        uncertain ? "" : retainedMissing ? "Retained result unavailable." : input.diagnostic.title,
        input.diagnostic.explanation,
        input.recoveryHint ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  // Resource and credential blockers stay visible alongside the failure itself.
  if (kind === "cleanup")
    issues.push({
      severity: "warning",
      code: "cleanup-unconfirmed",
      message: "The connection may still be active",
      detail: "Cleanup is unconfirmed. Reconnection is not safe recovery yet.",
    });
  else if (credentialMutationBlocked(reason))
    issues.push({
      severity: "warning",
      code: "credential-unconfirmed",
      message: mcpIssueMessages["credential-unconfirmed"],
    });
  if (input.truncated)
    issues.push({
      severity: "warning",
      code: "output-truncated",
      message: "Some output is unavailable",
      detail: "Output is unavailable or truncated. Do not replay to recover output.",
    });
  if (input.notices.length)
    issues.push({
      severity: "warning",
      code: "unclassified-notices",
      message: mcpIssueMessages["unclassified-notices"],
      detail: input.notices.join("\n"),
    });
  return {
    outcome: uncertain ? "uncertain" : kind === "cancelled" ? "cancelled" : "error",
    status: uncertain
      ? "Outcome unknown"
      : input.outcome === "not-sent"
        ? "Not sent"
        : "Completed with a problem",
    issues,
  };
}
