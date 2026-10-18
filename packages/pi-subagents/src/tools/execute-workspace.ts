import { absurd } from "effect/Function";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { clipText, countLabel, sanitizeTerminalLine } from "pi-cosmic-core";
import { Check } from "typebox/value";
import { invalidRequest } from "../run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../run/service.ts";
import { SUBAGENT_ROOT_RUN_ID } from "../run/model.ts";
import type { WorkspaceReviseOptions } from "../run/workspace-launch.ts";
import type { WorkspaceIntegrationOutcome } from "../run/workspace-integration.ts";
import { UnavailableWorkspaceArtifactSchema, WorkspaceRecordSchema } from "../workspace/model.ts";
import type { WorkspaceToolDetails, WorkspaceWarning } from "./details-schema.ts";
import {
  WorkspaceParameters,
  workspaceOperationError,
  type SubagentWorkspaceInput,
} from "./schema.ts";

const preparedCwdMetadata = (
  cwd: string,
  span: NonNullable<WorkspaceToolDetails["displayContent"]>,
) => (cwd.length <= 1_024 ? { preparedCwd: cwd } : { displayContent: span });

const result = (
  text: string,
  details: Omit<WorkspaceToolDetails, "version" | "action">,
): AgentToolResult<WorkspaceToolDetails> => ({
  content: [{ type: "text", text }],
  details: {
    version: 1,
    action: "workspace",
    displayContent: { offset: 0, length: 0 },
    ...details,
  },
});

const MAX_LISTED_PATHS = 8;

const fileName = (name: string) =>
  clipText(sanitizeTerminalLine(name.replace(/\/+$/u, "").split("/").pop() ?? ""), 40) || "A file";

const listedPaths = (paths: ReadonlyArray<string>) => {
  const listed = paths
    .slice(0, MAX_LISTED_PATHS)
    .map((name) => JSON.stringify(clipText(name, 256)))
    .join(", ");
  const more =
    paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : "";
  return `${listed}${more}`;
};

function integrationWarnings(outcome: WorkspaceIntegrationOutcome): WorkspaceWarning[] {
  const warnings: WorkspaceWarning[] = [];
  const worker = JSON.stringify(outcome.workerRoot);
  const drifted = outcome.untouchedDriftPaths;
  if (drifted.length > 0) {
    const onlyPath = drifted.length === 1 ? drifted[0] : undefined;
    warnings.push({
      code: "untested-parent-changes",
      message:
        onlyPath !== undefined
          ? `${fileName(onlyPath)} changed in the parent after testing`
          : `${countLabel(drifted.length, "parent file")} changed after testing`,
      detail: `The integration published only the proposal's own changes and kept these parent edits, which it doesn't touch, as they are: ${listedPaths(drifted)}. They changed after the combined tree was prepared, so tests run there didn't include them; rerun relevant tests in the parent checkout.`,
    });
  }
  const children = outcome.retainedForChildren ?? [];
  if (children.length > 0)
    warnings.push({
      code: "worker-retained-for-children",
      message:
        children.length === 1
          ? "The working copy was kept for an unresolved child worktree"
          : `The working copy was kept for ${countLabel(children.length, "unresolved child worktree")}`,
      detail: `The integration committed, but child worktrees created from the worker tree are still unresolved: ${listedPaths(children)}. The worker tree at ${worker} stays until each child is applied or discarded; then discard this worktree to delete the tree.`,
    });
  if (outcome.treeRemovalFailed)
    warnings.push({
      code: "workspace-trees-remain",
      message: "The proposal's working copies couldn't be deleted",
      detail: `The integration committed, but removing the worktree's worker and test trees failed; the worker tree at ${worker} and any test trees beside it remain on disk. Discard this worktree to retry the removal.`,
    });
  const backups = outcome.remainingBackupPaths;
  if (backups.length > 0)
    warnings.push({
      code: "integration-backups-remain",
      message:
        backups.length === 1
          ? "A backup of a replaced file couldn't be deleted from the checkout"
          : `${countLabel(backups.length, "backup")} of replaced files couldn't be deleted from the checkout`,
      detail: `The integration committed, but deleting these backups from the parent checkout failed: ${listedPaths(backups)}. Each holds a file's content from before the integration; delete them once that content is no longer needed.`,
    });
  if (outcome.leaseReleaseUnconfirmed)
    warnings.push({
      code: "integration-lease-unconfirmed",
      message: "The source checkout lock wasn't released; new writers are blocked",
      detail:
        "The integration committed, but releasing its source writer lease could not be confirmed. This session refuses writer starts and further integrations (workspace_integration_quarantined) until Pi restarts. After a restart the source lease may report recovery-required; recover it only after confirming no Pi session or writer still uses this checkout.",
    });
  return warnings;
}

function leftOutWarnings(credentials: ReadonlyArray<string>): WorkspaceWarning[] {
  if (credentials.length === 0) return [];
  return [
    {
      code: "credential-files-left-out",
      message:
        credentials.length === 1
          ? "A credential file the worker created was left out"
          : `${countLabel(credentials.length, "credential file")} the worker created were left out`,
      detail: `Proposals leave out worker-created files with credential names that aren't source code (such as .env, .npmrc, keys, and credentials or secrets files), so local secrets never reach the parent checkout: ${listedPaths(credentials)}. Create them in the parent checkout yourself if the change needs them.`,
    },
  ];
}

const WorkspaceMetadataSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  status: WorkspaceRecordSchema.fields.status,
  cwd: Schema.String,
  sourceCwd: Schema.String,
  sourceWorkspaceId: Schema.optional(Schema.String),
  revisionId: Schema.optional(Schema.String),
  preparationId: Schema.optional(Schema.String),
  /** Set on another session's workspace once that session ended. */
  orphan: Schema.optional(Schema.Literals(["adoptable", "discard-only"])),
});
const encodeWorkspaceMetadata = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Union([WorkspaceMetadataSchema, UnavailableWorkspaceArtifactSchema]),
  ),
);

const ORPHAN_GUIDANCE =
  "orphan=adoptable entries belong to ended sessions: review, prepare, apply, or revise takes one over. orphan=discard-only entries (nested or left mid-integration) can only be discarded, which rolls back an interrupted integration.";

const executeWorkspaceList = (
  service: SubagentServiceContract,
  callerRunId: string,
  offset: number,
) =>
  Effect.gen(function* () {
    const listing = yield* service.workspaceList(callerRunId);
    const entries = [
      ...listing.records.map((record) => ({
        workspaceId: record.handle.workspaceId,
        ownerId: record.handle.ownerId,
        status: record.status,
        cwd: record.handle.cwd,
        sourceCwd: record.handle.sourceCwd,
        ...(record.handle.sourceWorkspaceId !== undefined && {
          sourceWorkspaceId: record.handle.sourceWorkspaceId,
        }),
        ...(record.revision && { revisionId: record.revision.revisionId }),
        ...(record.preparation && { preparationId: record.preparation.preparationId }),
        ...(listing.orphans?.has(record.handle.workspaceId) && {
          orphan: listing.orphans.get(record.handle.workspaceId),
        }),
      })),
      ...listing.unavailable,
    ].toSorted((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    const lines: string[] = [];
    let chars = 0;
    for (const entry of entries.slice(offset, offset + 8)) {
      const line = yield* encodeWorkspaceMetadata(entry).pipe(
        Effect.mapError(() =>
          invalidRequest(
            "workspace_metadata_invalid",
            "Worktree metadata could not be encoded safely; inspect private worktree state manually.",
          ),
        ),
      );
      if (line.length > 32_000)
        return yield* invalidRequest(
          "workspace_metadata_too_large",
          "Worktree metadata exceeds the safe output bound; inspect private worktree state manually.",
        );
      if (chars + line.length > 32_000) break;
      chars += line.length;
      lines.push(line);
    }
    const nextOffset = offset + lines.length < entries.length ? offset + lines.length : undefined;
    const adoptableCount = [...(listing.orphans?.values() ?? [])].filter(
      (disposition) => disposition === "adoptable",
    ).length;
    const sourceUnavailableCount = listing.unavailable.filter(
      (entry) => entry.reason === "source-workspace-unavailable",
    ).length;
    return result(
      [
        ...lines,
        ...(listing.unavailable.length > sourceUnavailableCount
          ? [
              "Incomplete worktree metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
            ]
          : []),
        ...(sourceUnavailableCount > 0
          ? [
              "Some nested worktrees name a source worktree whose record is missing or unreadable (reason source-workspace-unavailable). Their source tree and cleanup are unknown; preserve them and recover manually.",
            ]
          : []),
        nextOffset === undefined
          ? "End of worktree list."
          : `More worktrees: call list with offset=${nextOffset}.`,
        ...(listing.orphans !== undefined && listing.orphans.size > 0 ? [ORPHAN_GUIDANCE] : []),
      ].join("\n"),
      {
        operation: "list",
        offset,
        workspaceCount: entries.length,
        ...(adoptableCount > 0 && { adoptableCount }),
        unavailableCount: listing.unavailable.length,
        ...(sourceUnavailableCount > 0 && { sourceUnavailableCount }),
        listedCount: lines.length,
        displayContent: { offset: 0, length: lines.join("\n").length },
        ...(nextOffset !== undefined && { nextOffset }),
      },
    );
  });

type WorkspaceReceipt = Pick<WorkspaceToolDetails, "operation" | "workspaceId">;

const executeWorkspaceReview = (
  service: SubagentServiceContract,
  operation: SubagentWorkspaceInput,
  receipt: WorkspaceReceipt,
  callerRunId: string,
) =>
  Effect.gen(function* () {
    const workspaceId = operation.workspaceId ?? "";
    const review = yield* service.workspaceReview(
      workspaceId,
      {
        ...(operation.revisionId !== undefined && { revisionId: operation.revisionId }),
        offset: operation.offset ?? 0,
        limit: operation.limit ?? 16_000,
      },
      callerRunId,
    );
    const prefix = [
      `Worktree ${workspaceId}; immutable revision ${review.revisionId}.`,
      `Review characters ${review.offset}..${review.offset + review.text.length} of ${review.totalChars}: a summary of changed files and line counts, then the diff.`,
      review.nextOffset !== undefined
        ? `More pages: review workspaceId=${workspaceId} offset=${review.nextOffset}. Read every page before prepare.`
        : "End of review. Apply it, or prepare it and test in the returned cwd first.",
      "BEGIN IMMUTABLE REVIEW PAGE",
    ].join("\n");
    return result([prefix, review.text, "END IMMUTABLE REVIEW PAGE"].join("\n"), {
      ...receipt,
      revisionId: review.revisionId,
      offset: review.offset,
      totalChars: review.totalChars,
      displayContent: { offset: prefix.length + 1, length: review.text.length },
      ...(review.nextOffset !== undefined && { nextOffset: review.nextOffset }),
    });
  });

const executeWorkspacePrepare = (
  service: SubagentServiceContract,
  operation: SubagentWorkspaceInput,
  receipt: WorkspaceReceipt,
  callerRunId: string,
) =>
  Effect.gen(function* () {
    const preparation = yield* service.workspacePrepare(
      operation.workspaceId ?? "",
      operation.revisionId ?? "",
      callerRunId,
    );
    const prefix = `Prepared revision ${preparation.revisionId}; preparationId=${preparation.preparationId}.`;
    const cwdLine = `Combined test cwd: ${preparation.cwd}`;
    const warnings = leftOutWarnings(preparation.leftOutPaths);
    return result(
      [
        prefix,
        cwdLine,
        `Run relevant tests in this cwd, which combines the proposal with your current edits; don't edit it. Then apply workspaceId=${operation.workspaceId ?? ""}, which integrates this preparation.`,
        ...warnings.map((warning) => `Warning: ${warning.detail}`),
      ].join("\n"),
      {
        ...receipt,
        revisionId: preparation.revisionId,
        preparationId: preparation.preparationId,
        ...(warnings.length > 0 && { warnings }),
        ...preparedCwdMetadata(preparation.cwd, {
          offset: prefix.length + 1,
          length: cwdLine.length,
        }),
      },
    );
  });

const appliedReviewLine = (reviewed: boolean) =>
  reviewed
    ? "Reviewed: every diff page of this revision was read before apply."
    : "Unreviewed: apply ran without the diff being read. Inspect the changed files in the parent checkout if the change needs review.";

const APPLY_TESTING_LINES = {
  "parent-tested":
    "Tested by you: apply integrated the preparation you tested in its combined cwd.",
  untested:
    "Untested: apply prepared and integrated in one call without running anything. Run relevant tests in the parent checkout.",
} as const;

const executeWorkspaceApply = (
  service: SubagentServiceContract,
  operation: SubagentWorkspaceInput,
  receipt: WorkspaceReceipt,
  callerRunId: string,
) =>
  Effect.gen(function* () {
    const workspaceId = operation.workspaceId ?? "";
    const applied = yield* service.workspaceApply(
      workspaceId,
      operation.preparationId !== undefined && operation.revisionId !== undefined
        ? { revisionId: operation.revisionId, preparationId: operation.preparationId }
        : { revisionId: operation.revisionId, paths: operation.paths },
      callerRunId,
    );
    const ids = `worktree ${workspaceId}, revision ${applied.revisionId}, preparationId=${applied.preparationId}`;
    const changed = `Changed files (${applied.changedPathCount}): ${applied.changedPaths.length > 0 ? listedPaths(applied.changedPaths) : "none listed"}${applied.changedPathCount > applied.changedPaths.length ? ` (${applied.changedPathCount - applied.changedPaths.length} not listed)` : ""}`;
    const remainingCount = applied.remainingPathCount;
    const remaining =
      remainingCount === undefined
        ? []
        : [
            `Partial apply: ${countLabel(remainingCount, "other changed file")} ${remainingCount === 1 ? "stays" : "stay"} in worktree ${workspaceId} as an unreviewed proposal: ${listedPaths(applied.remainingPaths ?? [])}${remainingCount > (applied.remainingPaths ?? []).length ? ` (${remainingCount - (applied.remainingPaths ?? []).length} not listed)` : ""}. Apply, review, revise, or discard them later.`,
          ];
    const metadata = {
      ...receipt,
      revisionId: applied.revisionId,
      preparationId: applied.preparationId,
      changedPathCount: applied.changedPathCount,
      ...(remainingCount !== undefined && { remainingPathCount: remainingCount }),
      reviewed: applied.reviewed,
      testing: applied.testing,
      ...(applied.preparedCwd.length <= 1_024 && { preparedCwd: applied.preparedCwd }),
    };
    const warnings = [...integrationWarnings(applied), ...leftOutWarnings(applied.leftOutPaths)];
    const heading = [
      `Applied ${ids} as uncommitted parent edits. The parent index was preserved. Do not stage or commit unless the user asks.`,
      appliedReviewLine(applied.reviewed),
      APPLY_TESTING_LINES[applied.testing],
    ].join("\n");
    const body = [changed, ...remaining].join("\n");
    return result(
      [heading, body, ...warnings.map((warning) => `Warning: ${warning.detail}`)].join("\n"),
      {
        ...metadata,
        ...(warnings.length > 0 && { warnings }),
        displayContent: { offset: heading.length + 1, length: body.length },
      },
    );
  });

/**
 * `resolveLaunch` resolves an adopted workspace's recorded launch for its first revision; the
 * host supplies it with its profiles and parent context.
 */
export const executeWorkspaceAction = (
  operation: SubagentWorkspaceInput,
  callerRunId = SUBAGENT_ROOT_RUN_ID,
  resolveLaunch?: WorkspaceReviseOptions["resolveLaunch"],
) =>
  Effect.gen(function* () {
    const error = Check(WorkspaceParameters, operation)
      ? workspaceOperationError(operation)
      : "Worktree arguments failed strict validation.";
    if (error !== undefined) return yield* invalidRequest("workspace_input_invalid", error);
    const service = yield* SubagentService;
    const workspaceId = operation.workspaceId ?? "";
    const receipt = { operation: operation.action, ...(workspaceId && { workspaceId }) };
    switch (operation.action) {
      case "list":
        return yield* executeWorkspaceList(service, callerRunId, operation.offset ?? 0);
      case "review":
        return yield* executeWorkspaceReview(service, operation, receipt, callerRunId);
      case "prepare":
        return yield* executeWorkspacePrepare(service, operation, receipt, callerRunId);
      case "apply":
        return yield* executeWorkspaceApply(service, operation, receipt, callerRunId);
      case "discard":
        yield* service.workspaceDiscard(workspaceId, callerRunId);
        return result("Discarded the worktree proposal; parent files were not changed.", receipt);
      case "revise": {
        const { run, rebase } = yield* service.workspaceRevise(
          workspaceId,
          operation.message ?? "",
          callerRunId,
          { rebase: operation.rebase, resolveLaunch },
        );
        const conflicts = rebase?.conflictedPaths ?? [];
        const rebased =
          rebase === undefined
            ? []
            : [
                conflicts.length === 0
                  ? "Rebased: the writer's tree was rebuilt from your current files, and its changes reapplied cleanly."
                  : `Rebased: the writer's tree was rebuilt from your current files, and its changes were reapplied with ${countLabel(conflicts.length, "conflicted file")} the successor was told to resolve first: ${listedPaths(conflicts)}.`,
              ];
        return result(
          [
            `Revision requested; successor runId=${run.id}. Await it, then apply or review its new revision; earlier review and preparation no longer apply.`,
            ...rebased,
          ].join("\n"),
          {
            ...receipt,
            successorRunId: run.id,
            ...(rebase && { rebased: true, conflictCount: conflicts.length }),
          },
        );
      }
    }
    return absurd<never>(operation.action);
  });
