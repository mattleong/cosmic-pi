import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Check } from "typebox/value";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../run/service.ts";
import { SUBAGENT_ROOT_RUN_ID } from "../run/model.ts";
import { UnavailableWorkspaceArtifactSchema, WorkspaceRecordSchema } from "../workspace/model.ts";
import type { WorkspaceToolDetails } from "./details-schema.ts";
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

const WorkspaceMetadataSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  status: WorkspaceRecordSchema.fields.status,
  cwd: Schema.String,
  sourceCwd: Schema.String,
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
        ...(record.revision && { revisionId: record.revision.revisionId }),
        ...(record.preparation && { preparationId: record.preparation.preparationId }),
      })),
      ...listing.unavailable,
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    const lines: string[] = [];
    let chars = 0;
    for (const entry of entries.slice(offset, offset + 8)) {
      const line = yield* encodeWorkspaceMetadata(entry).pipe(
        Effect.mapError(
          () =>
            new InvalidSubagentRequestError({
              code: "workspace_metadata_invalid",
              message:
                "Workspace metadata could not be encoded safely; inspect private workspace state manually.",
            }),
        ),
      );
      if (line.length > 32_000)
        return yield* new InvalidSubagentRequestError({
          code: "workspace_metadata_too_large",
          message:
            "Workspace metadata exceeds the safe output bound; inspect private workspace state manually.",
        });
      if (chars + line.length > 32_000) break;
      chars += line.length;
      lines.push(line);
    }
    const nextOffset = offset + lines.length < entries.length ? offset + lines.length : undefined;
    return result(
      [
        ...lines,
        ...(listing.unavailable.length > 0
          ? [
              "Incomplete workspace metadata: some recovery records are missing, invalid, or unreadable. Their ownership, source identity, and cleanup are unknown; manual recovery is required.",
            ]
          : []),
        nextOffset === undefined
          ? "End of workspace list."
          : `More workspaces: call list with offset=${nextOffset}.`,
        "Metadata visibility does not authorize recovery. If ownership/cleanup evidence is unavailable, independently verify writer descendants are dead and preserve the private workspace/journal before manual repair. Do not auto-adopt or delete an orphan.",
      ].join("\n"),
      {
        operation: "list",
        offset,
        workspaceCount: entries.length,
        unavailableCount: listing.unavailable.length,
        listedCount: lines.length,
        displayContent: { offset: 0, length: lines.join("\n").length },
        ...(nextOffset !== undefined && { nextOffset }),
      },
    );
  });

/** The coordinator binds identity and enforces direct-parent authority before any engine access. */
export const executeWorkspaceAction = (
  operation: SubagentWorkspaceInput,
  callerRunId = SUBAGENT_ROOT_RUN_ID,
) =>
  Effect.gen(function* () {
    const error = Check(WorkspaceParameters, operation)
      ? workspaceOperationError(operation)
      : "Workspace arguments failed strict validation.";
    if (error !== undefined)
      return yield* new InvalidSubagentRequestError({
        code: "workspace_input_invalid",
        message: error,
      });
    const service = yield* SubagentService;
    const workspaceId = operation.workspaceId ?? "";
    const revisionId = operation.revisionId ?? "";
    const receipt = { operation: operation.action, ...(workspaceId && { workspaceId }) };
    switch (operation.action) {
      case "list":
        return yield* executeWorkspaceList(service, callerRunId, operation.offset ?? 0);
      case "review": {
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
      }
      case "prepare": {
        const preparation = yield* service.workspacePrepare(workspaceId, revisionId, callerRunId);
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
      }
      case "integrate": {
        const preparationId = operation.preparationId ?? "";
        yield* service.workspaceIntegrate(workspaceId, revisionId, preparationId, callerRunId);
        return result(
          "Integrated the exact reviewed and tested revision as uncommitted parent edits. The parent index was preserved. Do not stage or commit unless the user asks.",
          { ...receipt, revisionId, preparationId },
        );
      }
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
  });
