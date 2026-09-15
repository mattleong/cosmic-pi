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
  const add = (text: string) => notices.push({ kind: "recovery", text });
  switch (details.operation) {
    case "list":
      if (details.workspaceCount !== undefined && details.listedCount !== undefined)
        counters.push(`${details.listedCount}/${details.workspaceCount} workspaces shown`);
      else metadata.push("workspace metadata");
      if (!isEmptyList(details))
        add(
          "Metadata visibility does not authorize recovery. If ownership or cleanup evidence is unavailable, independently verify writer descendants are dead and preserve the private workspace/journal before manual repair. Do not auto-adopt or delete an orphan.",
        );

      if (details.nextOffset !== undefined)
        add(`More workspace metadata: list offset=${details.nextOffset}.`);
      break;
    case "review":
      counters.push(`diff offset ${details.offset} of ${details.totalChars}`);
      add(
        `Diff page available in expanded details. Read ALL pages of exact revisionId=${details.revisionId} before prepare or integrate.${details.nextOffset === undefined ? " End of diff does not prove earlier pages were read." : ` Next: review workspaceId=${details.workspaceId}, revisionId=${details.revisionId}, offset=${details.nextOffset}.`} After complete review, prepare this exact revision, run relevant tests in the returned combined cwd, then integrate the exact revisionId and preparationId.`,
      );
      break;
    case "prepare":
      counters.push("prepared");
      add(
        `Combined test cwd: ${details.preparedCwd ?? "see expanded details"}. Run relevant tests there; do not edit this prepared tree. After passing tests and complete diff review, integrate this exact revisionId and preparationId. Parent drift requires fresh preparation and tests.`,
      );
      break;
    case "revise":
      add(
        `Prior review and preparation are invalid. Await successor ${details.successorRunId ?? "shown in expanded details"}, then review its new immutable revision from the beginning before preparing and testing again.`,
      );
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
    counters,
    metadata,
    notices,
    outcome: "success",
    detailsOnExpand: true,
  };
}
