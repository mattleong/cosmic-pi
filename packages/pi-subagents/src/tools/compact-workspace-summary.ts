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

function appliedFiles(changed: number, remaining: number | undefined): string {
  return remaining === undefined
    ? `${countLabel(changed, "file")} applied`
    : `${changed} of ${countLabel(changed + remaining, "file")} applied`;
}

// Narrower fallbacks first drop the file count, then the review state, keeping testing.
function applyCounters(details: WorkspaceToolDetails): string[] {
  if (details.testing === undefined || details.changedPathCount === undefined) return [];
  const tested = TESTING_LABELS[details.testing];
  const reviewed = details.reviewed ? "reviewed" : "unreviewed";
  return [
    `${appliedFiles(details.changedPathCount, details.remainingPathCount)} · ${reviewed} · ${tested}`,
    `${reviewed} · ${tested}`,
    tested,
  ];
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
      if (details.workspaceCount === 0) return "No workspaces";
      const listed =
        details.listedCount < details.workspaceCount
          ? `${details.listedCount} of ${countLabel(details.workspaceCount, "workspace")}`
          : countLabel(details.listedCount, "workspace");
      const sourceless = details.sourceUnavailableCount ?? 0;
      const unreadable = (details.unavailableCount ?? 0) - sourceless;
      const adoptable = details.adoptableCount ?? 0;
      return [
        listed,
        ...(unreadable > 0 ? [`${unreadable} unreadable`] : []),
        ...(sourceless > 0 ? [`${sourceless} missing their source`] : []),
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
    details.sourceUnavailableCount !== undefined &&
    details.sourceUnavailableCount > (details.unavailableCount ?? 0)
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

function isEmptyList(details: WorkspaceToolDetails): boolean {
  return (
    details.workspaceCount === 0 && details.listedCount === 0 && details.nextOffset === undefined
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
        readonly reviewed: boolean;
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
    (details.changedPathCount === undefined ||
      details.reviewed === undefined ||
      details.testing === undefined)
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
  const sourceless = details.sourceUnavailableCount ?? 0;
  if ((details.unavailableCount ?? 0) > sourceless)
    issues.push({
      severity: "warning",
      code: "workspace-records-unavailable",
      message: "Some workspace records are unreadable; ownership and cleanup are unknown",
      detail:
        "Incomplete workspace metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
    });
  if (sourceless > 0)
    issues.push({
      severity: "warning",
      code: "workspace-source-unavailable",
      message:
        sourceless === 1
          ? "A nested workspace's source workspace is missing or unreadable"
          : `${sourceless} nested workspaces' source workspaces are missing or unreadable`,
      detail:
        "These nested workspaces name a source workspace whose record is missing or unreadable (source-workspace-unavailable). Their source tree and cleanup are unknown; preserve them and recover manually.",
    });
  const adoptable = details.adoptableCount ?? 0;
  if (adoptable > 0)
    issues.push(
      step(
        "orphans-adoptable",
        adoptable === 1
          ? "A workspace from an ended session can be adopted"
          : `${adoptable} workspaces from ended sessions can be adopted`,
        "Entries marked orphan=adoptable belong to sessions that have ended. Review, prepare, apply, or revise takes one over for this session; discard deletes it. Do either only when the user asks.",
      ),
    );
  if (!isEmptyList(details))
    issues.push(
      step(
        "orphan-recovery",
        "Listing a workspace does not authorize its recovery",
        "Metadata visibility does not authorize recovery. Adopt or discard another session's workspace only when the user asks; orphan=discard-only entries (nested or left mid-integration) can only be discarded. If ownership or cleanup evidence is unavailable, independently verify writer descendants are dead and preserve the worker tree and recovery record before manual repair.",
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

function reviewIssues(details: WorkspaceReviewReceipt): CompactIssue[] {
  const next =
    details.nextOffset === undefined
      ? " End of review does not prove earlier pages were read."
      : ` Next: review workspaceId=${details.workspaceId}, revisionId=${details.revisionId}, offset=${details.nextOffset}.`;
  return [
    step(
      "read-revision",
      "Read every review page before preparing",
      `Review page available in expanded details; the first page summarizes changed files and line counts. Read ALL pages of exact revisionId=${details.revisionId} before prepare.${next}`,
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
      "apply-preparation",
      "Apply only after tests pass",
      "Only after passing tests, apply the exact revisionId and preparationId.",
    ),
  ];
}

function testingStep(details: WorkspaceApplyReceipt): CompactIssue {
  switch (details.testing) {
    case "parent-tested":
      return step(
        "applied-parent-tested",
        "Applied the preparation you tested",
        "Apply integrated the exact revisionId and preparationId you prepared; the tests you ran in the prepared cwd are the evidence.",
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
  const remaining = details.remainingPathCount;
  return [
    ...asWarnings(details),
    ...(remaining === undefined
      ? []
      : [
          step(
            "remaining-proposal",
            remaining === 1
              ? "One changed file stays in the workspace"
              : `${remaining} changed files stay in the workspace`,
            `Partial apply integrated only the chosen paths. The revision's ${countLabel(remaining, "other changed file")} ${remaining === 1 ? "stays" : "stay"} in workspace ${details.workspaceId} as an unreviewed proposal; apply, review, revise, or discard ${remaining === 1 ? "it" : "them"} later.`,
          ),
        ]),
    ...(details.reviewed
      ? []
      : [
          step(
            "applied-unreviewed",
            "The diff wasn't read before apply",
            "Apply integrated the proposal without a complete diff review. Inspect the changed files in the parent checkout if the change needs review.",
          ),
        ]),
    testingStep(details),
  ];
}

function reviseIssues(details: WorkspaceToolDetails): CompactIssue[] {
  const conflicts = details.conflictCount ?? 0;
  return [
    {
      severity: "warning",
      code: "revision-invalidated",
      message: "Earlier review and test preparation no longer apply",
      detail: `Prior review and preparation are invalid. Await successor ${details.successorRunId ?? "shown in expanded details"}, then review its new immutable revision from the beginning before preparing and testing again.`,
    },
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
          "Test the prepared tree without editing it",
          `Combined test cwd: ${details.preparedCwd ?? "see expanded details"}. Run relevant tests there; do not edit this prepared tree.`,
        ),
        step(
          "apply-preparation",
          "Apply only after tests pass",
          "After passing tests and complete review, apply this exact revisionId and preparationId. Parent drift requires fresh preparation and tests.",
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
    metadata: details.operation === "list" && line === undefined ? ["workspace metadata"] : [],
    issues,
    outcome: compactIssueSeverity(issues) ?? "success",
  };
}
