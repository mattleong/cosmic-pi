import { absurd } from "effect/Function";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { clipText, countLabel, sanitizeTerminalLine } from "pi-cosmic-core";
import { Check } from "typebox/value";
import { invalidRequest } from "../run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../run/service.ts";
import { SUBAGENT_ROOT_RUN_ID } from "../run/model.ts";
import type { WorkspaceApplyResult } from "../run/workspace-apply.ts";
import type { WorkspaceIntegrationOutcome } from "../run/workspace-integration.ts";
import { UnavailableWorkspaceArtifactSchema, WorkspaceRecordSchema } from "../workspace/model.ts";
import {
  MAX_WORKSPACE_VERIFICATION_TEXT_CHARS,
  type WorkspaceToolDetails,
  type WorkspaceWarning,
} from "./details-schema.ts";
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
  const paths = outcome.uncapturedPaths;
  const worker = JSON.stringify(outcome.workerRoot);
  if (paths.length > 0) {
    const onlyPath = paths.length === 1 ? paths[0] : undefined;
    warnings.push({
      code: "worker-retained",
      message:
        onlyPath !== undefined
          ? `${fileName(onlyPath)} wasn't in the proposal, so the working copy was kept`
          : `${countLabel(paths.length, "file")} weren't in the proposal, so the working copy was kept`,
      detail: `The workspace snapshot did not capture these worker files, so they were neither reviewed nor integrated: ${listedPaths(paths)}. The worker tree, which these paths are relative to, was kept at ${worker} so they are not lost. Copy any you need into the parent checkout, then discard this workspace to delete the tree.`,
    });
  }
  const children = outcome.retainedForChildren ?? [];
  if (children.length > 0)
    warnings.push({
      code: "worker-retained-for-children",
      message:
        children.length === 1
          ? "The working copy was kept for an unresolved child workspace"
          : `The working copy was kept for ${countLabel(children.length, "unresolved child workspace")}`,
      detail: `The integration committed, but child workspaces created from the worker tree are still unresolved: ${listedPaths(children)}. The worker tree at ${worker} stays until each child is integrated or discarded; then discard this workspace to delete the tree.`,
    });
  if (outcome.treeRemovalFailed)
    warnings.push({
      code: "workspace-trees-remain",
      message: "The proposal's working copies couldn't be deleted",
      detail: `The integration committed, but removing the workspace's worker and test trees failed; the worker tree at ${worker} and any test trees beside it remain on disk. Discard this workspace to retry the removal.`,
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

const integrationResult = (
  outcome: WorkspaceIntegrationOutcome,
  receipt: Omit<WorkspaceToolDetails, "version" | "action" | "warnings">,
) => {
  const warnings = integrationWarnings(outcome);
  return result(
    [
      "Integrated the exact reviewed and tested revision as uncommitted parent edits. The parent index was preserved. Do not stage or commit unless the user asks.",
      ...warnings.map((warning) => `Warning: ${warning.detail}`),
    ].join("\n"),
    { ...receipt, ...(warnings.length > 0 && { warnings }) },
  );
};

const WorkspaceMetadataSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  status: WorkspaceRecordSchema.fields.status,
  cwd: Schema.String,
  sourceCwd: Schema.String,
  sourceWorkspaceId: Schema.optional(Schema.String),
  revisionId: Schema.optional(Schema.String),
  preparationId: Schema.optional(Schema.String),
});
const encodeWorkspaceMetadata = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Union([WorkspaceMetadataSchema, UnavailableWorkspaceArtifactSchema]),
  ),
);

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
            "Workspace metadata could not be encoded safely; inspect private workspace state manually.",
          ),
        ),
      );
      if (line.length > 32_000)
        return yield* invalidRequest(
          "workspace_metadata_too_large",
          "Workspace metadata exceeds the safe output bound; inspect private workspace state manually.",
        );
      if (chars + line.length > 32_000) break;
      chars += line.length;
      lines.push(line);
    }
    const nextOffset = offset + lines.length < entries.length ? offset + lines.length : undefined;
    const sourceUnavailableCount = listing.unavailable.filter(
      (entry) => entry.reason === "source-workspace-unavailable",
    ).length;
    return result(
      [
        ...lines,
        ...(listing.unavailable.length > sourceUnavailableCount
          ? [
              "Incomplete workspace metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
            ]
          : []),
        ...(sourceUnavailableCount > 0
          ? [
              "Some nested workspaces name a source workspace whose record is missing or unreadable (reason source-workspace-unavailable). Their source tree and cleanup are unknown; preserve them and recover manually.",
            ]
          : []),
        nextOffset === undefined
          ? "End of workspace list."
          : `More workspaces: call list with offset=${nextOffset}.`,
        "Metadata visibility does not authorize recovery. If ownership/cleanup evidence is unavailable, independently verify writer descendants are dead and preserve the private workspace/journal before manual repair. Do not auto-adopt or delete an orphan. When the user asks, discard deletes an orphan whose creating session has ended once no writer holds it.",
      ].join("\n"),
      {
        operation: "list",
        offset,
        workspaceCount: entries.length,
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
      `Workspace ${workspaceId}; immutable revision ${review.revisionId}.`,
      `Diff characters ${review.offset}..${review.offset + review.diff.length} of ${review.totalChars}.`,
      review.nextOffset !== undefined
        ? `Incomplete review. Call review with workspaceId=${workspaceId}, revisionId=${review.revisionId}, offset=${review.nextOffset}. Read ALL pages before prepare/integrate.`
        : "End of diff. After reviewing every page, prepare this exact revision and run relevant tests in the returned combined cwd before integrate.",
      "BEGIN IMMUTABLE DIFF PAGE",
    ].join("\n");
    return result([prefix, review.diff, "END IMMUTABLE DIFF PAGE"].join("\n"), {
      ...receipt,
      revisionId: review.revisionId,
      offset: review.offset,
      totalChars: review.totalChars,
      displayContent: { offset: prefix.length + 1, length: review.diff.length },
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
    return result(
      [
        prefix,
        cwdLine,
        "Run relevant tests in this cwd, which combines the proposal with current parent edits. Do not edit this prepared tree. After passing tests and complete diff review, integrate with this exact revisionId and preparationId. Parent drift requires fresh preparation and tests.",
      ].join("\n"),
      {
        ...receipt,
        revisionId: preparation.revisionId,
        preparationId: preparation.preparationId,
        ...preparedCwdMetadata(preparation.cwd, {
          offset: prefix.length + 1,
          length: cwdLine.length,
        }),
      },
    );
  });

const PASSED_TAIL_LINES = 8;
const PASSED_TAIL_CHARS = 1_000;

const verificationText = (text: string) =>
  clipText(sanitizeTerminalLine(text), MAX_WORKSPACE_VERIFICATION_TEXT_CHARS);

const lastLines = (text: string, lines: number, chars: number) =>
  text.trimEnd().split("\n").slice(-lines).join("\n").slice(-chars);

const outputSection = (heading: string, tail: string) =>
  tail.trim() ? [heading, "BEGIN OUTPUT TAIL", tail, "END OUTPUT TAIL"] : [`${heading} (empty)`];

const appliedReviewLine = (reviewed: boolean) =>
  reviewed
    ? "Reviewed: every diff page of this revision was read before apply."
    : "Unreviewed: apply ran without the diff being read. Inspect the changed files in the parent checkout if the change needs review.";

const applyVerificationLines = (
  verification: Extract<WorkspaceApplyResult, { readonly integrated: true }>["verification"],
) =>
  verification.status === "passed"
    ? {
        status: [`Verified: ${sanitizeTerminalLine(verification.command.join(" "))} passed.`],
        output: outputSection(
          "Verification output tail:",
          lastLines(verification.outputTail, PASSED_TAIL_LINES, PASSED_TAIL_CHARS),
        ),
      }
    : {
        status: [
          "Not verified: no workspace verification command is configured, so the change wasn't tested. Run relevant tests in the parent checkout.",
        ],
        output: [],
      };

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
      operation.revisionId === undefined ? {} : { revisionId: operation.revisionId },
      callerRunId,
    );
    const ids = `workspace ${workspaceId}, revision ${applied.revisionId}, preparationId=${applied.preparationId}`;
    const changed = `Changed files (${applied.changedPathCount}): ${applied.changedPaths.length > 0 ? listedPaths(applied.changedPaths) : "none listed"}${applied.changedPathCount > applied.changedPaths.length ? ` (${applied.changedPathCount - applied.changedPaths.length} not listed)` : ""}`;
    const command =
      "command" in applied.verification
        ? verificationText(applied.verification.command.join(" "))
        : "";
    const metadata = {
      ...receipt,
      revisionId: applied.revisionId,
      preparationId: applied.preparationId,
      changedPathCount: applied.changedPathCount,
      reviewed: applied.reviewed,
      verification: applied.verification.status,
      ...(command && { verificationCommand: command }),
      ...(applied.preparedCwd.length <= 1_024 && { preparedCwd: applied.preparedCwd }),
    };
    if (!applied.integrated) {
      const { verification } = applied;
      const heading = `Verification failed for ${ids}. Nothing was applied; parent files are unchanged, and this preparation can't be integrated.`;
      const body = [
        `Command: ${sanitizeTerminalLine(verification.command.join(" "))}`,
        `Failure: ${sanitizeTerminalLine(verification.message)}`,
        `Prepared tree (inspect it; don't edit it): ${applied.preparedCwd}`,
        changed,
        ...outputSection("Verification output tail:", verification.outputTail),
      ].join("\n");
      const message = verificationText(verification.message);
      return result([heading, body, `Next steps: ${applied.nextSteps}`].join("\n"), {
        ...metadata,
        ...(message && { verificationMessage: message }),
        displayContent: { offset: heading.length + 1, length: body.length },
      });
    }
    const warnings = integrationWarnings(applied);
    const { status, output } = applyVerificationLines(applied.verification);
    const heading = [
      `Applied ${ids} as uncommitted parent edits. The parent index was preserved. Do not stage or commit unless the user asks.`,
      appliedReviewLine(applied.reviewed),
      ...status,
    ].join("\n");
    const body = [changed, ...output].join("\n");
    return result(
      [heading, body, ...warnings.map((warning) => `Warning: ${warning.detail}`)].join("\n"),
      {
        ...metadata,
        ...(warnings.length > 0 && { warnings }),
        displayContent: { offset: heading.length + 1, length: body.length },
      },
    );
  });

export const executeWorkspaceAction = (
  operation: SubagentWorkspaceInput,
  callerRunId = SUBAGENT_ROOT_RUN_ID,
) =>
  Effect.gen(function* () {
    const error = Check(WorkspaceParameters, operation)
      ? workspaceOperationError(operation)
      : "Workspace arguments failed strict validation.";
    if (error !== undefined) return yield* invalidRequest("workspace_input_invalid", error);
    const service = yield* SubagentService;
    const workspaceId = operation.workspaceId ?? "";
    const revisionId = operation.revisionId ?? "";
    const receipt = { operation: operation.action, ...(workspaceId && { workspaceId }) };
    switch (operation.action) {
      case "list":
        return yield* executeWorkspaceList(service, callerRunId, operation.offset ?? 0);
      case "review":
        return yield* executeWorkspaceReview(service, operation, receipt, callerRunId);
      case "prepare":
        return yield* executeWorkspacePrepare(service, operation, receipt, callerRunId);
      case "integrate": {
        const preparationId = operation.preparationId ?? "";
        const outcome = yield* service.workspaceIntegrate(
          workspaceId,
          revisionId,
          preparationId,
          callerRunId,
        );
        return integrationResult(outcome, { ...receipt, revisionId, preparationId });
      }
      case "apply":
        return yield* executeWorkspaceApply(service, operation, receipt, callerRunId);
      case "discard":
        yield* service.workspaceDiscard(workspaceId, callerRunId);
        return result(
          "Discarded the workspace proposal after confirmed cleanup; parent files were not changed.",
          receipt,
        );
      case "revise": {
        const run = yield* service.workspaceRevise(
          workspaceId,
          operation.message ?? "",
          callerRunId,
        );
        return result(
          `Revision requested; successor runId=${run.id}. Prior review and preparation are invalid. Await this run, then review its new immutable revision from the beginning before preparing and testing again.`,
          { ...receipt, successorRunId: run.id },
        );
      }
    }
    return absurd<never>(operation.action);
  });
