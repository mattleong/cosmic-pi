import * as Schema from "effect/Schema";

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  operation: Schema.String,
  message: Schema.String,
  /** The path, rule, and remedy behind a refusal, shown beneath the message. */
  detail: Schema.optional(Schema.String),
  cleanupUnconfirmed: Schema.optional(Schema.Boolean),
}) {}

export const WorkspaceHandleSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  sourceCwd: Schema.String,
  sourceRoot: Schema.String,
  cwd: Schema.String,
  /** Original writer-lease identity; absent in records saved before identity retention. */
  writerCwd: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      filesystemIdentity: Schema.String,
      digest: Schema.String,
    }),
  ),
  /** Tracked files the snapshot left out because they sit in dependency or build directories. */
  omittedTrackedPaths: Schema.optional(Schema.Array(Schema.String)),
  /** The workspace whose worker tree is this one's source; absent for a real checkout. */
  sourceWorkspaceId: Schema.optional(Schema.String),
  /** The real checkout at the top of a nested chain; absent when `sourceRoot` is that checkout. */
  checkoutRoot: Schema.optional(Schema.String),
});
export type WorkspaceHandle = typeof WorkspaceHandleSchema.Type;
/** The real checkout a workspace ultimately comes from, through any chain of nested sources. */
export const workspaceCheckoutRoot = (handle: WorkspaceHandle) =>
  handle.checkoutRoot ?? handle.sourceRoot;
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
  /** Names the lease the creating session holds while it runs; a free lease proves it ended. */
  ownerLease: Schema.optional(Schema.String),
  /** Setup may still own processes in this tree. Cleared only after confirmed cleanup. */
  setupCleanupPending: Schema.optional(Schema.String),
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
  /** An unreadable record, or a nested record whose source workspace chain can't be resolved. */
  reason: Schema.Literals(["recovery-record-unavailable", "source-workspace-unavailable"]),
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
export interface WorkspaceSetupTarget extends WorkspaceTarget {
  /** Checks the prepared test tree instead of the worker tree. */
  readonly preparationId?: string | undefined;
}
export interface WorkspaceVerifyTarget extends WorkspaceTarget {
  readonly preparationId: string;
}
/** A trusted project's argv command, run without a shell at the root of an isolated tree. */
export interface WorkspaceTreeCommand {
  readonly command: ReadonlyArray<string>;
  readonly timeoutSeconds?: number | undefined;
}
export interface WorkspaceQuarantineObserver {
  /**
   * Called once the call leaves no durable setup-cleanup marker: it was refused before marking
   * the tree, or the command's processes were confirmed stopped and the marker cleared, including
   * after interruption. Never called while the artifact stays quarantined.
   */
  readonly onQuarantineCleared?: (() => void) | undefined;
}
export interface WorkspaceVerification {
  /** The last lines of the command's output, stdout followed by stderr. */
  readonly outputTail: string;
}
export interface WorkspaceWorkerChanges {
  /** Captured paths whose content differs from the baseline. */
  readonly changedPaths: ReadonlyArray<string>;
  /** Writer-created files no capture can hold, such as `.env` or vendored code; gitignored files don't count. */
  readonly uncapturedPaths: ReadonlyArray<string>;
}
export interface WorkspaceOrphanTarget {
  readonly workspaceId: string;
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
  /** Preimage backups left in the source checkout because deleting them failed. */
  readonly remainingBackupPaths: ReadonlyArray<string>;
  /** Unresolved child workspaces created from the worker tree, which therefore stays. */
  readonly retainedForChildren?: ReadonlyArray<string> | undefined;
}
export type WorkspaceAcquired = (handle: WorkspaceHandle) => void;
