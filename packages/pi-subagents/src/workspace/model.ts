import * as Schema from "effect/Schema";
import type { WorkspaceDiffStatFile } from "./diffstat.ts";

/** Failures a caller can act on specifically; others surface as a generic workspace failure. */
const WORKSPACE_ERROR_CODES = [
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

const WorkspaceHandleSchema = Schema.Struct({
  workspaceId: Schema.String,
  ownerId: Schema.String,
  sourceCwd: Schema.String,
  sourceRoot: Schema.String,
  /** The workspace's private directory, which holds its record, patch, and every tree. */
  artifactRoot: Schema.String,
  cwd: Schema.String,
  /** Original writer-lease identity; absent until creation has made the worker tree ready. */
  writerCwd: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      filesystemIdentity: Schema.String,
      digest: Schema.String,
    }),
  ),
});
export type WorkspaceHandle = typeof WorkspaceHandleSchema.Type;
/**
 * Whether the worker path still names the directory the original writer lease was taken on.
 * Without that identity no one can prove a writer stopped there, so nothing may take it over.
 */
export const isOriginalWorker = (
  handle: WorkspaceHandle,
  current: { readonly filesystemIdentity: string },
) =>
  handle.writerCwd !== undefined &&
  handle.writerCwd.filesystemIdentity === current.filesystemIdentity;
/** A frozen revision as its record keeps it; the patch is stored in a file beside the record. */
const WorkspaceRevisionMetadataSchema = Schema.Struct({
  revisionId: Schema.String,
  changedPaths: Schema.Array(Schema.String),
  /** Untracked worker files left out on purpose because their names look like credentials. */
  uncapturedPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkspaceRevisionMetadata = typeof WorkspaceRevisionMetadataSchema.Type;
export interface WorkspaceRevision extends WorkspaceRevisionMetadata {
  readonly diff: string;
}
const WorkspacePreparationSchema = Schema.Struct({
  preparationId: Schema.String,
  revisionId: Schema.String,
  cwd: Schema.String,
});
export type WorkspacePreparation = typeof WorkspacePreparationSchema.Type;
/** What the writer that created a workspace was launched as, so an adopting session can revise it. */
const WorkspaceLaunchSchema = Schema.Struct({
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
  ownerLease: Schema.String,
  revision: Schema.optional(WorkspaceRevisionMetadataSchema),
  preparation: Schema.optional(WorkspacePreparationSchema),
  /**
   * The preparation's tested tree and the parent capture it was built on. Integration writes the
   * paths where they differ; discarding an `integrating` record puts those paths back.
   */
  preparedTree: Schema.optional(Schema.String),
  parentTree: Schema.optional(Schema.String),
  sourceHead: Schema.optional(Schema.String),
  sourceIndex: Schema.optional(Schema.String),
  /**
   * The worker tree a rebase rebuilt, which differs from the baseline by the reapplied changes;
   * WorktreeCreate hooks run in it may change nothing else. Freeze and revise drop it.
   */
  rebasedTree: Schema.optional(Schema.String),
  /** Epoch milliseconds of the last record save. */
  lastChangedAt: Schema.Finite,
  launch: Schema.optional(WorkspaceLaunchSchema),
  /**
   * Untracked files `.worktreeinclude` copied into the worker tree, relative to its root. Every
   * capture leaves them out, so they never reach a revision or publication.
   */
  includedPaths: Schema.optional(Schema.Array(Schema.String)),
  /** Set on a record the orphan sweep discarded, which keeps its revision patch until collection. */
  disposition: Schema.optional(Schema.Literal("orphan-swept")),
});
export type WorkspaceRecord = typeof WorkspaceRecordSchema.Type;
/** Statuses with an open worker tree, which a writer, revision, or adopting session may continue. */
export const OPEN_WORKSPACE_STATUSES: ReadonlySet<WorkspaceRecord["status"]> = new Set([
  "active",
  "frozen",
  "prepared",
]);

export const UnavailableWorkspaceArtifactSchema = Schema.Struct({
  workspaceId: Schema.String,
  status: Schema.Literal("unavailable"),
  reason: Schema.Literal("recovery-record-unavailable"),
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
export interface WorkspaceHookTarget extends WorkspaceTarget {
  /** Names the prepared test tree instead of the worker tree. */
  readonly preparationId?: string | undefined;
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
export interface WorkspacePreparationTarget extends WorkspaceTarget {
  readonly revisionId: string;
}
export interface WorkspaceRebase {
  /** The previous changes reapplied onto the fresh snapshot. */
  readonly reappliedPaths: ReadonlyArray<string>;
  /** Files the three-way merge left conflicted; text files keep conflict markers. */
  readonly conflictedPaths: ReadonlyArray<string>;
}
export interface WorkspaceIntegrationTarget
  extends WorkspacePreparationTarget, WorkspaceSettledTarget {
  readonly preparationId: string;
  readonly retainTrees?: boolean;
}
export interface WorkspaceIntegration {
  readonly record: WorkspaceRecord;
  readonly workerRoot: string;
  /** Parent files the proposal doesn't touch that changed after preparation; they were kept. */
  readonly untouchedDriftPaths: ReadonlyArray<string>;
  readonly treeRemovalFailed: boolean;
}
export type WorkspaceAcquired = (handle: WorkspaceHandle) => void;
