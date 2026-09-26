import { mcpBoundaryDescriptions } from "./compact-descriptions.ts";
import type { CompactIssue, CompactIssues, CompactSummary } from "pi-code-previews";
import type { McpDiagnostic } from "../client/diagnostics.ts";
import type { McpBoundaryError } from "../client/errors.ts";

export interface McpBoundaryView {
  readonly outcome: NonNullable<CompactSummary["outcome"]>;
  readonly status: string;
  readonly issues: CompactIssues;
}

export const credentialMutationBlocked = (reason: McpBoundaryError["reason"]): boolean =>
  reason === "oauth-mutation-unresolved" ||
  reason === "oauth-finalization-failed" ||
  reason === "oauth-deletion-failed";

/** Only fixed, validated boundary diagnostics enter this view. Remote messages stay
 * in the original raw details; unclassified notices keep their own attention.
 * Callers own the gates that decide whether it replaces the legacy layout. */
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
  const blocked = kind === "cleanup" || credentialMutationBlocked(reason);
  const retainedMissing =
    input.action === "result.read" && (kind === "stale" || kind === "not-found");
  const recovery: Array<{ code: string; text: string }> = [];
  const diagnostics: string[] = [];
  // Uncertainty and resource/credential blockers must remain visible collapsed.
  // Routine explanations and navigation are available on expansion.
  if (uncertain || blocked)
    recovery.push({ code: "boundary-recovery", text: input.diagnostic.explanation });
  else diagnostics.push(input.diagnostic.explanation);
  if (uncertain && kind === "cleanup")
    recovery.push({
      code: "cleanup-gate",
      text: "Cleanup is unconfirmed. Reconnection is not safe recovery yet.",
    });
  if (input.truncated)
    recovery.push({
      code: "output-loss",
      text: "Output is unavailable or truncated. Do not replay to recover output.",
    });
  if (input.recoveryHint) diagnostics.push(input.recoveryHint);
  const entries: CompactIssue[] = [
    {
      operation: "mcp",
      code: "boundary-failure",
      // A validated boundary failure is separate from dispatch certainty.
      severity: !uncertain && kind === "cancelled" ? "warning" : "error",
      cause: uncertain
        ? ""
        : retainedMissing
          ? "Retained result unavailable."
          : input.diagnostic.title,
      description: [
        uncertain
          ? "Could not confirm the operation's outcome."
          : retainedMissing
            ? "Saved output is not available."
            : mcpBoundaryDescriptions[kind],
        kind === "cleanup"
          ? "The connection may still be active."
          : blocked
            ? "Credential changes are not confirmed."
            : "",
        input.truncated ? "Some output is unavailable." : "",
      ]
        .filter(Boolean)
        .join(" "),
      recovery,
      diagnostics,
    },
  ];
  if (input.notices.length)
    entries.push({
      operation: "mcp",
      code: "unclassified-notices",
      severity: "warning",
      cause: input.notices.join("\n"),
      description: "The server reported additional warnings.",
      recovery: [],
    });
  return {
    outcome: uncertain ? "uncertain" : kind === "cancelled" ? "cancelled" : "error",
    status: uncertain
      ? "Outcome unknown"
      : input.outcome === "not-sent"
        ? "Not sent"
        : "Completed with a problem",
    issues: { coverage: "unknown", entries },
  };
}
