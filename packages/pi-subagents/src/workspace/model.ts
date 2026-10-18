import * as Schema from "effect/Schema";
import type { WorkspaceDiffStatFile } from "./diffstat.ts";

/** Failures a caller can act on specifically; others surface as a generic workspace failure. */
export const WORKSPACE_ERROR_CODES = [
  "workspace_conflict",
  "workspace_parent_changed",
  "workspace_rollback_refused",
  "workspace_rebase_refused",
  "workspace_local_override",
] as const;

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  operation: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.Literals(WORKSPACE_ERROR_CODES)),
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
  /** The workspace whose worker tree is this one's source; absent for a real checkout. */
  sourceWorkspaceId: Schema.optional(Schema.String),
  /** The real checkout at the top of a nested chain; absent when `sourceRoot` is that checkout. */
  checkoutRoot: Schema.optional(Schema.String),
});
export type WorkspaceHandle = typeof WorkspaceHandleSchema.Type;
/** The real checkout a workspace ultimately comes from, through any chain of nested sources. */
export const workspaceCheckoutRoot = (handle: WorkspaceHandle) =>
  handle.checkoutRoot ?? handle.sourceRoot;
/** A frozen revision as its record keeps it; the patch is stored in a file beside the record. */
export const WorkspaceRevisionMetadataSchema = Schema.Struct({
  revisionId: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  /** Untracked worker files left out on purpose because their names look like credentials. */
  uncapturedPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkspaceRevisionMetadata = typeof WorkspaceRevisionMetadataSchema.Type;
export interface WorkspaceRevision extends WorkspaceRevisionMetadata {
  readonly diff: string;
}
export const WorkspacePreparationSchema = Schema.Struct({
  preparationId: Schema.String,
  revisionId: Schema.String,
  cwd: Schema.String,
  leaseDirectories: Schema.Array(Schema.String),
  /** A partial preparation's subset of the revision's changed paths; absent for all of them. */
  paths: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkspacePreparation = typeof WorkspacePreparationSchema.Type;
const WorkspaceJournalFileSchema = Schema.Struct({
  /** SHA-256 of the file's bytes. */
  digest: Schema.String,
  mode: Schema.String,
  permissions: Schema.Finite,
});
/** What the writer that created a workspace was launched as, so an adopting session can revise it. */
export const WorkspaceLaunchSchema = Schema.Struct({
  profile: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
export type WorkspaceLaunch = typeof WorkspaceLaunchSchema.Type;
export const WorkspaceRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  handle: WorkspaceHandleSchema,
  /**
   * The source repository's common Git directory. The worker and prepared trees are its linked
   * worktrees, and the workspace's commits live there under `refs/pi/workspaces/<id>/`.
   */
  repository: Schema.String,
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
  /** Names the lease the creating session holds while it runs; a free lease proves it ended. */
  ownerLease: Schema.optional(Schema.String),
  /** Setup may still own processes in this tree. Cleared only after confirmed cleanup. */
  setupCleanupPending: Schema.optional(Schema.String),
  revision: Schema.optional(WorkspaceRevisionMetadataSchema),
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
  /** Missing ancestor directories publication creates, shallowest first. */
  plannedDirectories: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The worker tree a rebase rebuilt, which differs from the baseline by the reapplied changes;
   * setup run in it may change nothing else. Freeze and revise drop it.
   */
  rebasedTree: Schema.optional(Schema.String),
  /** Epoch milliseconds of the last record save; absent records use the record file's mtime. */
  lastChangedAt: Schema.optional(Schema.Finite),
  launch: Schema.optional(WorkspaceLaunchSchema),
  /**
   * Untracked files `workspaceInclude` copied into the worker tree, relative to its root. Every
   * capture leaves them out, so they never reach a revision or publication.
   */
  includedPaths: Schema.optional(Schema.Array(Schema.String)),
  /** Set on a record the orphan sweep discarded, which keeps its revision patch until collection. */
  disposition: Schema.optional(Schema.Literal("orphan-swept")),
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
  /**
   * Unfinished records another session created whose owner lease was free when listed, so that
   * session has ended. Advisory: adoption and discard recheck it under the checkout's lock.
   */
  readonly endedOwners?: ReadonlyArray<string> | undefined;
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
export interface WorkspaceVerification {
  /** The last lines of the command's output, stdout followed by stderr. */
  readonly outputTail: string;
}
export interface WorkspaceWorkerChanges {
  /** Captured paths whose content differs from the baseline. */
  readonly changedPaths: ReadonlyArray<string>;
  /** Writer-created credential files left out of every capture; gitignored files don't count. */
  readonly uncapturedPaths: ReadonlyArray<string>;
  /** Git's line counts for each changed path. */
  readonly diffStat: ReadonlyArray<WorkspaceDiffStatFile>;
}
export interface WorkspaceOrphanTarget {
  readonly workspaceId: string;
}
export interface WorkspaceOrphanDiscardTarget extends WorkspaceOrphanTarget {
  /**
   * The caller holds fresh writer leases on a mid-integration record's lease directories, so
   * discard may roll its publication back.
   */
  readonly sourceLeasesHeld?: true | undefined;
}
/** Takes over an orphan whose creating session ended; the caller proves its writer stopped. */
export interface WorkspaceAdoptTarget extends WorkspaceOrphanTarget {
  readonly ownerId: string;
}
export interface WorkspaceSweepTarget extends WorkspaceOrphanTarget {
  /** Records changed more recently than this many milliseconds ago are kept. */
  readonly minimumAgeMillis: number;
}
/** An orphan the sweep discarded, with the revision patch kept beside its record. */
export interface WorkspaceSwept {
  readonly workspaceId: string;
  readonly sourceRoot: string;
  readonly changedPathCount: number;
  readonly patchPath: string;
}
export interface WorkspaceSettledTarget extends WorkspaceTarget {
  readonly processCleanupConfirmed: true;
}
export interface WorkspaceRevisionTarget extends WorkspaceTarget {
  readonly revisionId: string;
}
export interface WorkspacePreparationTarget extends WorkspaceRevisionTarget {
  /** A strict, nonempty subset of the revision's changed paths to prepare alone. */
  readonly paths?: ReadonlyArray<string> | undefined;
}
export interface WorkspaceRebase {
  /** The previous changes reapplied onto the fresh snapshot. */
  readonly reappliedPaths: ReadonlyArray<string>;
  /** Files the three-way merge left conflicted; text files keep conflict markers. */
  readonly conflictedPaths: ReadonlyArray<string>;
}
export interface WorkspaceIntegrationTarget
  extends WorkspaceRevisionTarget, WorkspaceSettledTarget {
  readonly preparationId: string;
  readonly retainTrees?: boolean;
}
export interface WorkspaceIntegration {
  readonly record: WorkspaceRecord;
  readonly workerRoot: string;
  /** Parent files the proposal doesn't touch that changed after preparation; they were kept. */
  readonly untouchedDriftPaths: ReadonlyArray<string>;
  readonly treeRemovalFailed: boolean;
  /** Preimage backups left in the source checkout because deleting them failed. */
  readonly remainingBackupPaths: ReadonlyArray<string>;
  /** Unresolved child workspaces created from the worker tree, which therefore stays. */
  readonly retainedForChildren?: ReadonlyArray<string> | undefined;
  /**
   * A partial integration's changed paths left out; the workspace stays active with them as its
   * remaining proposal.
   */
  readonly remainingPaths?: ReadonlyArray<string> | undefined;
}
export type WorkspaceAcquired = (handle: WorkspaceHandle) => void;
