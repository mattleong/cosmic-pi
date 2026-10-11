import * as Schema from "effect/Schema";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  operation: Schema.String,
  message: Schema.String,
  cleanupUnconfirmed: Schema.optional(Schema.Boolean),
}) {}

export const WorkspaceHandleSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  sourceCwd: Schema.String,
  sourceRoot: Schema.String,
  cwd: Schema.String,
});
export type WorkspaceHandle = typeof WorkspaceHandleSchema.Type;
export const WorkspaceRevisionSchema = Schema.Struct({
  revisionId: Schema.String,
  diff: Schema.String,
  changedPaths: Schema.Array(Schema.String),
});
export type WorkspaceRevision = typeof WorkspaceRevisionSchema.Type;
export const WorkspacePreparationSchema = Schema.Struct({
  preparationId: Schema.String,
  revisionId: Schema.String,
  cwd: Schema.String,
  leaseDirectories: Schema.Array(Schema.String),
});
export type WorkspacePreparation = typeof WorkspacePreparationSchema.Type;
const WorkspaceJournalFileSchema = Schema.Struct({
  oid: Schema.String,
  mode: Schema.String,
  permissions: Schema.Finite,
});
export const WorkspaceRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  handle: WorkspaceHandleSchema,
  status: Schema.Literals([
    "creating",
    "active",
    "frozen",
    "prepared",
    "integrating",
    "integrated",
    "discarded",
  ]),
  baseline: Schema.String,
  predecessorWorkspaceId: Schema.optional(Schema.String),
  excludedPaths: Schema.optional(Schema.Array(Schema.String)),
  revision: Schema.optional(WorkspaceRevisionSchema),
  preparation: Schema.optional(WorkspacePreparationSchema),
  preparedTree: Schema.optional(Schema.String),
  parentTree: Schema.optional(Schema.String),
  sourceHead: Schema.optional(Schema.String),
  sourceIndex: Schema.optional(Schema.String),
  journal: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        temporaryPath: Schema.String,
        backupPath: Schema.String,
        before: Schema.optional(WorkspaceJournalFileSchema),
        after: Schema.optional(WorkspaceJournalFileSchema),
      }),
    ),
  ),
  publishedCount: Schema.optional(Schema.Finite),
  plannedDirectories: Schema.optional(Schema.Array(Schema.String)),
  createdDirectoryCount: Schema.optional(Schema.Finite),
});
export type WorkspaceRecord = typeof WorkspaceRecordSchema.Type;

export const UnavailableWorkspaceArtifactSchema = Schema.Struct({
  workspaceId: Schema.String,
  status: Schema.Literal("unavailable"),
  reason: Schema.Literal("recovery-record-unavailable"),
});
export type UnavailableWorkspaceArtifact = typeof UnavailableWorkspaceArtifactSchema.Type;
export interface WorkspaceListing {
  readonly records: ReadonlyArray<WorkspaceRecord>;
  readonly unavailable: ReadonlyArray<UnavailableWorkspaceArtifact>;
}
export interface WorkspaceTarget {
  readonly workspaceId: string;
  readonly ownerId: string;
}
export interface WorkspaceSettledTarget extends WorkspaceTarget {
  readonly processCleanupConfirmed: true;
}
export interface WorkspaceRevisionTarget extends WorkspaceTarget {
  readonly revisionId: string;
}
export interface WorkspaceIntegrationTarget
  extends WorkspaceRevisionTarget, WorkspaceSettledTarget {
  readonly preparationId: string;
  readonly retainTrees?: boolean;
}
export interface WorkspaceIntegration {
  readonly record: WorkspaceRecord;
  readonly workerRoot: string;
  readonly uncapturedPaths: ReadonlyArray<string>;
  readonly treeRemovalFailed: boolean;
}
export type WorkspaceAcquired = (handle: WorkspaceHandle) => void;
