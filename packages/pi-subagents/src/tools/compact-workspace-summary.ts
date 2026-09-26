import { compactIssueSeverity } from "pi-code-previews";
import * as Schema from "effect/Schema";
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { WorkspaceToolDetailsSchema, type WorkspaceToolDetails } from "./details-schema.ts";

const decode = Schema.decodeUnknownOption(WorkspaceToolDetailsSchema);

function validPagination(details: WorkspaceToolDetails): boolean {
  if (
    details.workspaceCount !== undefined &&
    details.listedCount !== undefined &&
    details.listedCount > details.workspaceCount
  )
    return false;
  if (
    details.unavailableCount !== undefined &&
    (details.operation !== "list" ||
      details.workspaceCount === undefined ||
      details.unavailableCount > details.workspaceCount)
  )
    return false;
  if (details.nextOffset !== undefined && details.nextOffset <= (details.offset ?? 0)) return false;
  if (details.operation !== "review") return true;
  return (
    details.offset !== undefined &&
    details.totalChars !== undefined &&
    details.offset <= details.totalChars &&
    (details.nextOffset === undefined || details.nextOffset <= details.totalChars)
  );
}

function isEmptyList(details: WorkspaceToolDetails): boolean {
  return (
    details.workspaceCount === 0 && details.listedCount === 0 && details.nextOffset === undefined
  );
}

function hasOperationReceipt(details: WorkspaceToolDetails): boolean {
  if (details.operation === "list") return true;
  if (!details.workspaceId) return false;
  if (["review", "prepare", "integrate"].includes(details.operation) && !details.revisionId)
    return false;
  return (
    !["prepare", "integrate"].includes(details.operation) || details.preparationId !== undefined
  );
}

const step = (code: string, message: string, detail: string): CompactIssue => ({
  severity: "info",
  code,
  message,
  detail,
});

function listIssues(details: WorkspaceToolDetails): CompactIssue[] {
  const issues: CompactIssue[] = [];
  if ((details.unavailableCount ?? 0) > 0)
    issues.push({
      severity: "warning",
      code: "workspace-records-unavailable",
      message: "Some workspace records are unreadable; ownership and cleanup are unknown",
      detail:
        "Incomplete workspace metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
    });
  if (!isEmptyList(details))
    issues.push(
      step(
        "orphan-recovery",
        "Listing a workspace does not authorize its recovery",
        "Metadata visibility does not authorize recovery. If ownership or cleanup evidence is unavailable, independently verify writer descendants are dead and preserve the private workspace/journal before manual repair. Do not auto-adopt or delete an orphan.",
      ),
    );
  if (details.nextOffset !== undefined)
    issues.push(
      step(
        "list-pagination",
        "More workspace entries are available",
        `More workspace metadata: list offset=${details.nextOffset}.`,
      ),
    );
  return issues;
}

function reviewIssues(details: WorkspaceToolDetails): CompactIssue[] {
  const next =
    details.nextOffset === undefined
      ? " End of diff does not prove earlier pages were read."
      : ` Next: review workspaceId=${details.workspaceId}, revisionId=${details.revisionId}, offset=${details.nextOffset}.`;
  return [
    step(
      "read-revision",
      "Read every diff page before preparing",
      `Diff page available in expanded details. Read ALL pages of exact revisionId=${details.revisionId} before prepare or integrate.${next}`,
    ),
    step(
      "prepare-revision",
      "Prepare this exact revision after review",
      "After complete review, prepare this exact revision.",
    ),
    step(
      "test-preparation",
      "Test the prepared tree without editing it",
      "Run relevant tests in the returned combined cwd; do not edit the prepared tree.",
    ),
    step(
      "integrate-preparation",
      "Integrate only after tests pass",
      "Only after passing tests, integrate the exact revisionId and preparationId.",
    ),
  ];
}

/** Review, test, and integration gates are procedure, not problems: shown only on expansion. */
export function compactWorkspaceSummary<ValueInput>(
  value: ValueInput,
  operation: string,
): CompactSummary | undefined {
  const decoded = decode(value);
  if (decoded._tag === "None" || decoded.value.operation !== operation) return undefined;
  const details = decoded.value;
  // Receipt fields are optional in the transport union, but required by these operations.
  if (!hasOperationReceipt(details) || !validPagination(details)) return undefined;
  const metadata: string[] = [];
  const counters: string[] = [];
  let issues: CompactIssue[] = [];
  switch (details.operation) {
    case "list":
      if (details.workspaceCount !== undefined && details.listedCount !== undefined)
        counters.push(`${details.listedCount}/${details.workspaceCount} workspace entries shown`);
      else metadata.push("workspace metadata");
      issues = listIssues(details);
      break;
    case "review":
      counters.push(`diff offset ${details.offset} of ${details.totalChars}`);
      issues = reviewIssues(details);
      break;
    case "prepare":
      counters.push("prepared");
      issues = [
        step(
          "test-preparation",
          "Test the prepared tree without editing it",
          `Combined test cwd: ${details.preparedCwd ?? "see expanded details"}. Run relevant tests there; do not edit this prepared tree.`,
        ),
        step(
          "integrate-preparation",
          "Integrate only after tests pass",
          "After passing tests and complete diff review, integrate this exact revisionId and preparationId. Parent drift requires fresh preparation and tests.",
        ),
      ];
      break;
    case "revise":
      issues = [
        {
          severity: "warning",
          code: "revision-invalidated",
          message: "Earlier review and test preparation no longer apply",
          detail: `Prior review and preparation are invalid. Await successor ${details.successorRunId ?? "shown in expanded details"}, then review its new immutable revision from the beginning before preparing and testing again.`,
        },
      ];
      break;
    case "integrate":
      counters.push("integrated");
      break;
    case "discard":
      break;
  }
  return {
    action: operation,
    subject: details.workspaceId ?? "",
    compactSubject: "Proposed changes",
    counters,
    metadata,
    issues,
    outcome: compactIssueSeverity(issues) ?? "success",
  };
}
