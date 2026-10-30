import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core/display";
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
          : countLabel(details.listedCount, "worktree");
      const unreadable = details.unavailableCount ?? 0;
      const adoptable = details.adoptableCount ?? 0;
      return Arr.join(
        [
          listed,
          ...(unreadable > 0 ? [`${unreadable} unreadable`] : []),
          ...(adoptable > 0 ? [`${adoptable} adoptable`] : []),
        ],
        ", ",
      );
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
  return Fn.absurd(details.operation);
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
  Arr.map(details.warnings ?? [], (warning) => ({
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
        "They belong to sessions that have ended; this session can take one over or discard it.",
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
          `This page ends at character ${details.nextOffset}${details.totalChars === undefined ? "" : ` of ${details.totalChars}`}.`,
        ),
      ];
}

function testingStep(details: WorkspaceApplyReceipt): CompactIssue {
  switch (details.testing) {
    case "parent-tested":
      return step(
        "applied-parent-tested",
        "Applied the tested preparation",
        "The combined tree was prepared and tested before it was applied.",
      );
    case "untested":
      return step(
        "applied-untested",
        "The change wasn't tested",
        "It was prepared and applied in one step, without running tests.",
      );
  }
  return Fn.absurd(details.testing);
}

function applyIssues(details: WorkspaceApplyReceipt): CompactIssue[] {
  return [...asWarnings(details), testingStep(details)];
}

function reviseIssues(details: WorkspaceToolDetails): CompactIssue[] {
  const conflicts = details.conflictCount ?? 0;
  return [
    step(
      "await-successor",
      "The writer is revising its proposal",
      "A new run makes the next revision; earlier reviews and preparations no longer apply.",
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
              "The rebase rebuilt the writer's tree from current parent files and reapplied its changes; these files kept conflict markers. The writer was asked to resolve them first.",
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
          "Prepared a combined tree for testing",
          "It combines the proposal with the current edits.",
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
  return Fn.absurd(details);
}

const decodeWorkspaceToolDetailsOption = Schema.decodeUnknownOption(WorkspaceToolDetailsSchema);

export const decodeWorkspaceToolDetails = Fn.flow(
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
    subject: details.writerName ?? "",
    counters:
      details.operation === "apply" ? applyCounters(details) : line === undefined ? [] : [line],
    metadata: details.operation === "list" && line === undefined ? ["worktree metadata"] : [],
    issues,
    outcome: compactIssueSeverity(issues) ?? "success",
  };
}
