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

/** Registry evidence only: never a handle, owner, source identity, or cleanup receipt. */
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
  /** Keeps the editable trees after integration because a live run still uses them. */
  readonly retainTrees?: boolean;
}
/** A committed integration and what it had to leave on disk. */
export interface WorkspaceIntegration {
  readonly record: WorkspaceRecord;
  /** The worker tree's root, which `uncapturedPaths` are relative to. */
  readonly workerRoot: string;
  /**
   * Worker files that the integrated revision did not capture, such as files of unsupported
   * types or at excluded paths. The worker starts from the baseline snapshot, which holds none
   * of them, so a writer created each one. The worker tree is kept so they are never deleted.
   */
  readonly uncapturedPaths: ReadonlyArray<string>;
  /** Removing the spent editable trees failed, so they remain on disk. */
  readonly treeRemovalFailed: boolean;
}
/**
 * Reports a newly acquired workspace synchronously, before its handle is returned, so an
 * interrupted caller still learns about the workspace it owns.
 */
export type WorkspaceAcquired = (handle: WorkspaceHandle) => void;
