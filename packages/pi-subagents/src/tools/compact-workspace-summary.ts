import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { flow, absurd } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core";
import { WorkspaceToolDetailsSchema, type WorkspaceToolDetails } from "./details-schema.ts";

function reviewPosition(details: WorkspaceToolDetails): string {
  const first = (details.offset ?? 0) === 0;
  if (details.nextOffset === undefined) return first ? "whole review" : "last review page";
  return `${first ? "first" : "next"} review page, more to read`;
}

const TESTING_LABELS = { "parent-tested": "tested", untested: "untested" } as const;

// The narrower fallback drops the file count, keeping testing.
function applyCounters(details: WorkspaceToolDetails): string[] {
  if (details.testing === undefined || details.changedPathCount === undefined) return [];
  const tested = TESTING_LABELS[details.testing];
  return [`${countLabel(details.changedPathCount, "file")} applied · ${tested}`, tested];
}

function reviseLine(details: WorkspaceToolDetails): string {
  if (!details.rebased) return "revision requested";
  const conflicts = details.conflictCount ?? 0;
  return conflicts === 0
    ? "rebased · revision requested"
    : `rebased with ${countLabel(conflicts, "conflict")} · revision requested`;
}

export function workspaceReceiptLine(details: WorkspaceToolDetails): string | undefined {
  switch (details.operation) {
    case "list": {
      if (details.workspaceCount === undefined || details.listedCount === undefined)
        return undefined;
      if (details.workspaceCount === 0) return "No worktrees";
      const listed =
        details.listedCount < details.workspaceCount
          ? `${details.listedCount} of ${countLabel(details.workspaceCount, "worktree")}`
          : countLabel(details.listedCount, "workspace");
      const unreadable = details.unavailableCount ?? 0;
      const adoptable = details.adoptableCount ?? 0;
      return [
        listed,
        ...(unreadable > 0 ? [`${unreadable} unreadable`] : []),
        ...(adoptable > 0 ? [`${adoptable} adoptable`] : []),
      ].join(", ");
    }
    case "review":
      return reviewPosition(details);
    case "prepare":
      return "ready to test";
    case "apply":
      return applyCounters(details)[0];
    case "revise":
      return reviseLine(details);
    case "discard":
      return "discarded";
  }
  return absurd(details.operation);
}

function validListCounts(details: WorkspaceToolDetails): boolean {
  if (
    details.workspaceCount !== undefined &&
    details.listedCount !== undefined &&
    details.listedCount > details.workspaceCount
  )
    return false;
  if (
    details.adoptableCount !== undefined &&
    (details.workspaceCount === undefined || details.adoptableCount > details.workspaceCount)
  )
    return false;
  return (
    details.unavailableCount === undefined ||
    (details.operation === "list" &&
      details.workspaceCount !== undefined &&
      details.unavailableCount <= details.workspaceCount)
  );
}

function validPagination(details: WorkspaceToolDetails): boolean {
  if (!validListCounts(details)) return false;
  if (details.nextOffset !== undefined && details.nextOffset <= (details.offset ?? 0)) return false;
  if (details.operation !== "review") return true;
  return (
    details.offset !== undefined &&
    details.totalChars !== undefined &&
    details.offset <= details.totalChars &&
    (details.nextOffset === undefined || details.nextOffset <= details.totalChars)
  );
}

type WorkspaceOperationReceipt = WorkspaceToolDetails &
  (
    | { readonly operation: "list" }
    | { readonly operation: "discard" | "revise"; readonly workspaceId: string }
    | {
        readonly operation: "review";
        readonly workspaceId: string;
        readonly revisionId: string;
      }
    | {
        readonly operation: "prepare";
        readonly workspaceId: string;
        readonly revisionId: string;
        readonly preparationId: string;
      }
    | {
        readonly operation: "apply";
        readonly workspaceId: string;
        readonly revisionId: string;
        readonly preparationId: string;
        readonly changedPathCount: number;
        readonly testing: NonNullable<WorkspaceToolDetails["testing"]>;
      }
  );

type WorkspaceApplyReceipt = Extract<WorkspaceOperationReceipt, { readonly operation: "apply" }>;

type WorkspaceReviewReceipt = Extract<WorkspaceOperationReceipt, { readonly operation: "review" }>;

function hasOperationReceipt(details: WorkspaceToolDetails): details is WorkspaceOperationReceipt {
  if (details.operation === "list") return true;
  if (!details.workspaceId) return false;
  if (["review", "prepare", "apply"].includes(details.operation) && !details.revisionId)
    return false;
  if (
    details.operation === "apply" &&
    (details.changedPathCount === undefined || details.testing === undefined)
  )
    return false;
  return !["prepare", "apply"].includes(details.operation) || details.preparationId !== undefined;
}

const asWarnings = (details: WorkspaceToolDetails): CompactIssue[] =>
  (details.warnings ?? []).map((warning) => ({
    severity: "warning",
    code: warning.code,
    message: warning.message,
    detail: warning.detail,
  }));

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
      message: "Some worktree records are unreadable; ownership and cleanup are unknown",
      detail:
        "Incomplete worktree metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
    });
  const adoptable = details.adoptableCount ?? 0;
  if (adoptable > 0)
    issues.push(
      step(
        "orphans-adoptable",
        adoptable === 1
          ? "A worktree from an ended session can be adopted"
          : `${adoptable} worktrees from ended sessions can be adopted`,
        "Entries marked orphan=adoptable belong to sessions that have ended. Review, prepare, apply, or revise takes one over for this session; discard deletes it.",
      ),
    );
  return issues;
}

function reviewIssues(details: WorkspaceReviewReceipt): CompactIssue[] {
  return details.nextOffset === undefined
    ? []
    : [
        step(
          "read-revision",
          "More review pages to read",
          `Next: review workspaceId=${details.workspaceId} offset=${details.nextOffset}.`,
        ),
      ];
}

function testingStep(details: WorkspaceApplyReceipt): CompactIssue {
  switch (details.testing) {
    case "parent-tested":
      return step(
        "applied-parent-tested",
        "Applied the preparation you tested",
        "Apply integrated the preparation you prepared; the tests you ran in its cwd are the evidence.",
      );
    case "untested":
      return step(
        "applied-untested",
        "The change wasn't tested",
        "Run relevant tests in the parent checkout before relying on this change.",
      );
  }
  return absurd(details.testing);
}

function applyIssues(details: WorkspaceApplyReceipt): CompactIssue[] {
  return [...asWarnings(details), testingStep(details)];
}

function reviseIssues(details: WorkspaceToolDetails): CompactIssue[] {
  const conflicts = details.conflictCount ?? 0;
  return [
    step(
      "await-successor",
      "Await the revising writer",
      `Await successor ${details.successorRunId ?? "shown in expanded details"}, then apply or review its new revision; earlier review and preparation no longer apply.`,
    ),
    ...(details.rebased && conflicts > 0
      ? [
          {
            severity: "warning" as const,
            code: "rebase-conflicts",
            message:
              conflicts === 1
                ? "One file has merge conflicts for the writer to resolve"
                : `${conflicts} files have merge conflicts for the writer to resolve`,
            detail:
              "The rebase rebuilt the writer's tree from current parent files and reapplied its changes; these files kept conflict markers. The successor's task lists them and asks it to resolve them first. Review its new revision for leftover markers.",
          },
        ]
      : []),
  ];
}

function operationIssues(details: WorkspaceOperationReceipt): CompactIssue[] {
  switch (details.operation) {
    case "list":
      return listIssues(details);
    case "review":
      return reviewIssues(details);
    case "prepare":
      return [
        step(
          "test-preparation",
          "Test the prepared tree, then apply",
          `Combined test cwd: ${details.preparedCwd ?? "see expanded details"}. Run relevant tests there without editing it, then apply workspaceId=${details.workspaceId}.`,
        ),
        ...asWarnings(details),
      ];
    case "revise":
      return reviseIssues(details);
    case "apply":
      return applyIssues(details);
    case "discard":
      return [];
  }
  return absurd(details);
}

const decodeWorkspaceToolDetailsOption = Schema.decodeUnknownOption(WorkspaceToolDetailsSchema);

export const decodeWorkspaceToolDetails = flow(
  Option.liftThrowable(decodeWorkspaceToolDetailsOption),
  Option.flatten,
  Option.getOrUndefined,
);

export function compactWorkspaceSummary(
  result: { readonly details?: unknown },
  operation: string,
): CompactSummary | undefined {
  const details = decodeWorkspaceToolDetails(result.details);
  if (
    details?.operation !== operation ||
    !hasOperationReceipt(details) ||
    !validPagination(details)
  )
    return undefined;
  const line = workspaceReceiptLine(details);
  const issues = operationIssues(details);
  return {
    action: operation === "list" ? "inspect" : operation,
    subject: "Proposed changes",
    counters:
      details.operation === "apply" ? applyCounters(details) : line === undefined ? [] : [line],
    metadata: details.operation === "list" && line === undefined ? ["worktree metadata"] : [],
    issues,
    outcome: compactIssueSeverity(issues) ?? "success",
  };
}
