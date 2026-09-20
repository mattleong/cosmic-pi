import { withCompactIssues } from "pi-code-previews";
import * as Schema from "effect/Schema";
import type { CompactSummary } from "pi-code-previews";
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

function unavailableNotices(details: WorkspaceToolDetails): NonNullable<CompactSummary["notices"]> {
  return (details.unavailableCount ?? 0) > 0
    ? [
        {
          code: "workspace-records-unavailable",
          kind: "warning",
          text: "Incomplete workspace metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
          description:
            "Some workspace artifacts lack readable recovery metadata; ownership and cleanup remain unknown.",
        },
      ]
    : [];
}

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
  const notices: NonNullable<CompactSummary["notices"]>[number][] = [];
  const add = (code: string, text: string) =>
    notices.push({
      code,
      kind: "recovery",
      text,
      description:
        code === "revision-invalidated"
          ? "Earlier review and test preparation no longer apply."
          : "",
    });
  switch (details.operation) {
    case "list":
      if (details.workspaceCount !== undefined && details.listedCount !== undefined)
        counters.push(`${details.listedCount}/${details.workspaceCount} workspace entries shown`);
      else metadata.push("workspace metadata");
      notices.push(...unavailableNotices(details));
      if (!isEmptyList(details))
        add(
          "orphan-recovery",
          "Metadata visibility does not authorize recovery. If ownership or cleanup evidence is unavailable, independently verify writer descendants are dead and preserve the private workspace/journal before manual repair. Do not auto-adopt or delete an orphan.",
        );

      if (details.nextOffset !== undefined)
        add("list-pagination", `More workspace metadata: list offset=${details.nextOffset}.`);
      break;
    case "review":
      counters.push(`diff offset ${details.offset} of ${details.totalChars}`);
      add(
        "read-revision",
        `Diff page available in expanded details. Read ALL pages of exact revisionId=${details.revisionId} before prepare or integrate.${details.nextOffset === undefined ? " End of diff does not prove earlier pages were read." : ` Next: review workspaceId=${details.workspaceId}, revisionId=${details.revisionId}, offset=${details.nextOffset}.`}`,
      );
      add("prepare-revision", "After complete review, prepare this exact revision.");
      add(
        "test-preparation",
        "Run relevant tests in the returned combined cwd; do not edit the prepared tree.",
      );
      add(
        "integrate-preparation",
        "Only after passing tests, integrate the exact revisionId and preparationId.",
      );
      break;
    case "prepare":
      counters.push("prepared");
      add(
        "test-preparation",
        `Combined test cwd: ${details.preparedCwd ?? "see expanded details"}. Run relevant tests there; do not edit this prepared tree.`,
      );
      add(
        "integrate-preparation",
        "After passing tests and complete diff review, integrate this exact revisionId and preparationId. Parent drift requires fresh preparation and tests.",
      );
      break;
    case "revise":
      add(
        "revision-invalidated",
        `Prior review and preparation are invalid. Await successor ${details.successorRunId ?? "shown in expanded details"}, then review its new immutable revision from the beginning before preparing and testing again.`,
      );
      break;
    case "integrate":
      counters.push("integrated");
      break;
    case "discard":
      break;
  }
  return withCompactIssues(
    {
      action: operation,
      subject: details.workspaceId ?? "",
      compactSubject: "Proposed changes",
      counters,
      metadata,
      notices,
      outcome: notices.some((notice) => notice.kind === "warning") ? "warning" : "success",
      detailsOnExpand: true,
    },
    workspaceIdentity(details),
  );
}

function workspaceIdentity(details: WorkspaceToolDetails): string {
  return `workspace:${details.workspaceId ?? "list"}:${details.revisionId ?? details.operation}`;
}
