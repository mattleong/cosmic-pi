import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { CrossProcessLock, type CrossProcessLease, type SafeFile } from "pi-cosmic-core";
import type { WorktreeHook } from "../config/schema.ts";
import { WorkspaceError, workspaceCheckoutRoot } from "../workspace/model.ts";
import { partialSelection } from "../workspace/policy.ts";
import { canonicalizeWriterDirectory } from "./writer-lease.ts";
import { runWorktreeHook } from "./worktree-hook.ts";
import { HOOK_QUARANTINE_REMEDY, worktreeKind, worktreeRemoveHooks } from "./git-worktree-hooks.ts";
import type {
  WorkspaceAcquired,
  WorkspaceHandle,
  WorkspaceIntegrationTarget,
  WorkspaceLaunch,
  WorkspaceListing,
  WorkspaceOrphanTarget,
  WorkspacePreparationTarget,
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceRevisionMetadata,
  WorkspaceHookTarget,
  WorkspaceSettledTarget,
  WorkspaceTarget,
  WorkspaceWorkerChanges,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  applyConflict,
  checkDirectory,
  gitFailure,
  gitSucceeded,
  listedPaths,
  oid,
  repositoryGit,
  repositoryGitResult,
  workspaceFailure,
  workspaceIO,
  workspaceRefusal,
} from "./git-worktree-process.ts";
import { supportedGitInstallation } from "./git-installation.ts";
import {
  headCommit,
  inspectSource,
  refuseHiddenLocalEdits,
  type SourceCheckout,
  sourceIdentity,
} from "./git-repository.ts";
import {
  captureTree,
  changedEntries,
  changedPaths as changedBetween,
  commitTree,
  diffStat,
  setWorkspaceRef,
  sourceLeftOut,
  treeEntries,
  treeHolds,
  treeOf,
  workerLeftOut,
} from "./git-capture.ts";
import { commitRevisionPatch, patchBytes, revisionText } from "./git-worktree-patch.ts";
import {
  copyIncludedFiles,
  includedLeftOut,
  matchIncludedFiles,
  readWorktreeInclude,
} from "./git-worktree-include.ts";
import { rebaseWorkspace } from "./git-worktree-rebase.ts";
import { orphanWorkspaceOperations } from "./git-worktree-orphans.ts";
import {
  addWorkspaceTree,
  preparationTree,
  removePreparation as removePreparationTree,
  withOutcome,
  workspaceArtifact,
  workspaceSubdirectory,
  workspaceWorker,
} from "./git-worktree-trees.ts";
import {
  initializeWorkspaceStore,
  newWorkspaceId,
  readRevisionDiff,
  readWorkspaceRecord,
  saveWorkspaceRecord,
  syncWorkspaceDirectory,
  validWorkspaceId,
  workspaceDirectory,
  ownerLockNamespace,
  sourceLockNamespace,
  withFreeLock,
  withWorkspaceStoreLock,
  workspaceLockDirectory,
} from "./git-worktree-store.ts";
import {
  collectWorkspaceRecords,
  listWorkspaceRecords,
  MAX_WORKSPACE_NESTING,
  removeWorkspaceTrees,
  unresolvedChildWorkspaces,
} from "./git-worktree-recovery.ts";
import {
  commitPublication,
  finishPublication,
  publishedMidIntegration,
  publishWorkspace,
  readPublishedFiles,
  removeEmptiedDirectories,
  removePublicationBackups,
  requiredLeaseDirectories,
  rollbackPublication,
  touchedParentDrift,
} from "./git-worktree-integration.ts";

const subdirectory = workspaceSubdirectory;

// Publication installs regular files only, so freeze refuses links and submodules that change.
const unpublishableMode = (mode: string) => mode === "120000" || mode === "160000";

interface WorkspaceSource extends SourceCheckout {
  /** Set when the source is another workspace's worker tree (see WorkspaceHandle). */
  readonly sourceWorkspaceId?: string | undefined;
  readonly checkoutRoot?: string | undefined;
}

interface CreateWorkspaceInput {
  readonly sourceCwd: string;
  readonly ownerId: string;
  readonly sourceWorkspace?: WorkspaceTarget | undefined;
  readonly launch?: WorkspaceLaunch | undefined;
  readonly onAcquired?: WorkspaceAcquired | undefined;
}

const withinTree = (tree: string, target: string) =>
  target === tree || target.startsWith(`${tree}${path.sep}`);

const nestedSourceRefusal = (sourceCwd: string) =>
  workspaceRefusal("create", "The session directory isn't the source workspace's worker tree.", {
    path: sourceCwd,
    rule: "a nested workspace's source must be its named source workspace's worker tree or a directory inside it, never a prepared tree, workspace directory, or another workspace",
    remedy: "Start the nested writer from the parent writer's own workspace directory.",
  });

/** The subset of `revision`'s changed paths to prepare, or undefined for all of them. */
const preparationPaths = (
  revision: WorkspaceRevisionMetadata,
  paths: ReadonlyArray<string> | undefined,
) =>
  Effect.gen(function* () {
    if (paths === undefined) return undefined;
    const { unknown, subset } = partialSelection(revision.changedPaths, paths);
    if (paths.length === 0 || unknown.length > 0)
      return yield* workspaceRefusal(
        "prepare",
        "Partial preparation names paths the revision doesn't change.",
        {
          ...(unknown.length === 1 && { path: unknown[0] }),
          rule: `a partial apply names a nonempty subset of the revision's changed paths${unknown.length > 1 ? `; unknown: ${listedPaths(unknown)}` : ""}`,
          remedy: "Review the revision's summary for its exact changed paths.",
        },
      );
    return subset;
  });

const settled = (target: WorkspaceSettledTarget) =>
  target.processCleanupConfirmed
    ? Effect.void
    : Effect.fail(workspaceFailure("cleanup", "Process cleanup must be independently confirmed."));

const withoutHookMarker = ({ setupCleanupPending: _pending, ...record }: WorkspaceRecord) => record;

// Failed WorktreeCreate hooks in a prepared tree leave the reviewed revision frozen, with nothing to integrate.
const withoutPreparation = ({
  preparation: _preparation,
  parentTree: _parentTree,
  preparedTree: _preparedTree,
  sourceHead: _sourceHead,
  sourceIndex: _sourceIndex,
  ...record
}: WorkspaceRecord): WorkspaceRecord => ({ ...record, status: "frozen" });

const MAX_LISTED_CHANGES = 5;

const listedChanges = (paths: ReadonlyArray<string>) =>
  `${paths.slice(0, MAX_LISTED_CHANGES).join(", ")}${
    paths.length > MAX_LISTED_CHANGES ? `, and ${paths.length - MAX_LISTED_CHANGES} more` : ""
  }`;

/** Serializes this process's workspace operations; WorktreeCreate hooks release it while they run. */
type WorkspaceOperationGate = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

const revision = (record: WorkspaceRecord, id: string) => {
  const current = record.revision;
  return current?.revisionId === id
    ? Effect.succeed(current)
    : Effect.fail(workspaceFailure("revision", "Reviewed revision is stale or unknown."));
};

// Symlinks are refused below the agent directory, not in the path that leads to it: ~/.pi is often
// a symlink, and macOS reaches /tmp and /var through one.
export const workspaceRegistry = (agentDirectory: string) =>
  Effect.promise(() => fs.realpath(agentDirectory).catch(() => path.resolve(agentDirectory))).pipe(
    Effect.map((root) => path.join(root, "subagent-worktrees")),
  );

/**
 * The engine for `registry` (see workspaceRegistry); CrossProcessLock must use its lock directory.
 * The caller serializes every operation with `gate` except WorktreeCreate hooks, which take it
 * for each phase. `worktreeRemove` hooks run before every removal of a tree a workspace handed out.
 */
export const gitWorkspaceEngine = (
  registry: string,
  gate: WorkspaceOperationGate,
  options: { readonly worktreeRemove?: ReadonlyArray<WorktreeHook> | undefined } = {},
) =>
  Effect.gen(function* () {
    const lockDirectory = workspaceLockDirectory(registry);
    const locks = yield* CrossProcessLock;
    const owned = new Set<string>();
    // Workspaces whose WorktreeCreate hooks this engine is running outside the locks.
    const settingUp = new Set<string>();
    const beforeRemove = worktreeRemoveHooks(registry, options.worktreeRemove ?? []);
    // Held from this engine's first workspace until its scope closes, so another session can
    // prove this one ended before discarding a workspace it left behind.
    let presence: { readonly token: string; readonly lease: CrossProcessLease } | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.try({
        try: () => presence?.lease.release(),
        catch: () => workspaceFailure("lock", "The workspace owner lease couldn't be released."),
      }).pipe(Effect.ignore),
    );
    const ownerPresence = Effect.gen(function* () {
      if (presence) return presence.token;
      const token = yield* newWorkspaceId;
      const lease = yield* locks
        .tryAcquire(ownerLockNamespace(token))
        .pipe(
          Effect.mapError(() =>
            workspaceFailure("lock", "The workspace owner lease couldn't be acquired."),
          ),
        );
      if (!lease)
        return yield* workspaceFailure("lock", "The workspace owner lease is already held.");
      presence = { token, lease };
      return token;
    });
    const directory = (record: WorkspaceRecord) => workspaceArtifact(registry, record);
    const worker = (record: WorkspaceRecord) => workspaceWorker(registry, record);
    const prepared = (record: WorkspaceRecord, preparationId: string) =>
      preparationTree(registry, record, preparationId);
    // Private trees hold only what a writer made; the source follows its own rule. Neither
    // captures included files: `checkedOut` is the commit the tree was checked out at.
    const captureWorker = (
      record: WorkspaceRecord,
      root = worker(record),
      checkedOut = record.baseline,
    ) =>
      includedLeftOut(record.repository, checkedOut, record.includedPaths).pipe(
        Effect.flatMap((included) => captureTree(root, directory(record), workerLeftOut, included)),
      );
    // A nested workspace's source is its source workspace's worker, with that one's included files.
    const sourceIncluded = (record: WorkspaceRecord) =>
      record.handle.sourceWorkspaceId === undefined
        ? Effect.succeed([])
        : readWorkspaceRecord(registry, record.handle.sourceWorkspaceId).pipe(
            Effect.flatMap((source) =>
              includedLeftOut(source.repository, source.baseline, source.includedPaths),
            ),
          );
    const captureSource = (record: WorkspaceRecord) =>
      sourceIncluded(record).pipe(
        Effect.flatMap((included) =>
          captureTree(record.handle.sourceRoot, directory(record), sourceLeftOut(record), included),
        ),
      );
    const managedRecord = (workspaceId: string) =>
      Effect.gen(function* () {
        const record = yield* readWorkspaceRecord(registry, workspaceId);
        if (record.setupCleanupPending !== undefined && settingUp.has(workspaceId))
          return yield* new WorkspaceError({
            operation: "hook",
            message: "WorktreeCreate hooks are still running.",
            detail: `Hook tree: ${record.setupCleanupPending}\nTry again once the hooks finish.`,
            cleanupUnconfirmed: true,
          });
        if (record.setupCleanupPending !== undefined)
          return yield* new WorkspaceError({
            operation: "hook",
            message: "Worktree hook cleanup is unconfirmed; the artifact is quarantined.",
            detail: `Hook tree: ${record.setupCleanupPending}\n${HOOK_QUARANTINE_REMEDY}`,
            cleanupUnconfirmed: true,
          });
        const relative = subdirectory(record);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          record.handle.cwd !== path.join(worker(record), relative)
        )
          return yield* workspaceFailure(
            "authorization",
            "Workspace paths do not match managed identity.",
          );
        return record;
      });
    const checked = (target: WorkspaceTarget, requireLiveOwner = true) =>
      Effect.gen(function* () {
        const record = yield* managedRecord(target.workspaceId);
        if (
          record.handle.ownerId !== target.ownerId ||
          (requireLiveOwner && !owned.has(target.workspaceId))
        )
          return yield* workspaceFailure(
            "authorization",
            "Workspace is not owned by this parent and live session.",
          );
        return record;
      });
    // Only trees a workspace handed out run WorktreeRemove; create and prepare roll back their
    // own half-made trees silently.
    const removePreparation = (record: WorkspaceRecord, preparationId: string) =>
      removePreparationTree(registry, record, preparationId, beforeRemove);
    const removeUnhanded = (record: WorkspaceRecord, preparationId: string) =>
      removePreparationTree(registry, record, preparationId);
    // Lock order: an operation holds at most one store lock, keyed by the real checkout at the top
    // of its record's nested chain (workspaceCheckoutRoot). A whole chain shares it, so a nested
    // workspace's integration into its source workspace's worker tree serializes with every
    // operation on that workspace and on the real checkout without ever nesting store locks. Owner
    // leases (orphan discard) are only taken inside it.
    const lockedSource = <A, E, R>(checkoutRoot: string, effect: Effect.Effect<A, E, R>) =>
      withWorkspaceStoreLock(locks, lockDirectory, checkoutRoot, effect);
    // The checkout root never changes for a record, so reading it before the lock is safe; the
    // operation itself rereads the record under the lock.
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>, target: WorkspaceOrphanTarget) =>
      readWorkspaceRecord(registry, target.workspaceId).pipe(
        Effect.flatMap((record) => lockedSource(workspaceCheckoutRoot(record.handle), effect)),
      );
    // A nested workspace integrates into its source workspace's worker tree, which must still
    // hold unfinished work and must not be running a worktree hook.
    const openSourceWorkspace = (record: WorkspaceRecord, operation: string) =>
      Effect.gen(function* () {
        const sourceId = record.handle.sourceWorkspaceId;
        if (sourceId === undefined) return undefined;
        const source = yield* managedRecord(sourceId);
        if (
          !["active", "frozen", "prepared"].includes(source.status) ||
          worker(source) !== record.handle.sourceRoot
        )
          return yield* workspaceRefusal(
            operation,
            "The source workspace's worker tree is no longer open.",
            {
              path: record.handle.sourceRoot,
              rule: "a nested workspace prepares and integrates only into the worker tree of an active, frozen, or prepared source workspace",
              remedy: "Discard this workspace; its source workspace was integrated or discarded.",
            },
          );
        return undefined;
      });
    // The durable child guard: a worker tree stays while a workspace created from it is unresolved.
    const refuseWithChildren = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const children = yield* unresolvedChildWorkspaces(registry, record.handle.workspaceId);
        if (children.length > 0)
          return yield* workspaceRefusal(
            "discard",
            "Workspaces created from this worker tree are unresolved.",
            {
              path: worker(record),
              rule: "a worker tree stays while a workspace created from it is neither integrated nor discarded",
              remedy: `Integrate or discard ${listedChanges(children)} first.`,
            },
          );
        return undefined;
      });

    const createInternal = (input: CreateWorkspaceInput, source: WorkspaceSource) =>
      Effect.gen(function* () {
        if (
          registry === source.sourceRoot ||
          registry.startsWith(`${source.sourceRoot}${path.sep}`)
        )
          return yield* workspaceFailure(
            "create",
            "Private workspaces must be outside the source checkout.",
          );
        const workspaceId = yield* newWorkspaceId;
        const dir = workspaceDirectory(registry, workspaceId);
        const handle: WorkspaceHandle = {
          workspaceId,
          ownerId: input.ownerId,
          sourceCwd: source.sourceCwd,
          sourceRoot: source.sourceRoot,
          cwd: path.join(dir, "worker", source.subdirectory),
          ...(source.sourceWorkspaceId !== undefined && {
            sourceWorkspaceId: source.sourceWorkspaceId,
            checkoutRoot: source.checkoutRoot,
          }),
        };
        let record: WorkspaceRecord = {
          version: 2,
          handle,
          repository: source.repository,
          status: "creating",
          baseline: "",
          ownerLease: yield* ownerPresence,
          ...(input.launch && { launch: input.launch }),
        };
        yield* Effect.gen(function* () {
          yield* workspaceIO("create", () => fs.mkdir(dir, { mode: 0o700 }));
          yield* syncWorkspaceDirectory(registry);
          yield* saveWorkspaceRecord(registry, record);
        }).pipe(Effect.uninterruptible);
        // A create that fails or is interrupted before it is acquired removes what it made,
        // including its worktree entry and refs in the user's repository, unless a Git process's
        // cleanup is uncertain. A crash leaves the creating record for collection.
        let handedOver = false;
        const removeCreated = Effect.gen(function* () {
          yield* removeWorkspaceTrees(registry, record);
          yield* workspaceIO("create-cleanup", () => fs.rm(dir, { recursive: true, force: true }));
        }).pipe(Effect.uninterruptible);
        return yield* Effect.gen(function* () {
          const { sourceRoot, repository } = source;
          const identity = yield* sourceIdentity(sourceRoot);
          const head = yield* headCommit(sourceRoot);
          const captured = yield* captureSource(record);
          const baseline = yield* commitTree(repository, captured.tree, [head], "baseline");
          if (
            source.subdirectory !== "" &&
            !(yield* treeHolds(repository, baseline, source.subdirectory))
          )
            return yield* workspaceRefusal(
              "create",
              "The session directory has no files a workspace can capture.",
              {
                path: source.subdirectory,
                rule: "the session directory must hold a tracked file or an untracked one Git doesn't ignore; empty and ignored directories are never part of a workspace",
                remedy:
                  "Start Pi in a directory with tracked or source files, such as the repository root, or use the shared-checkout writer mode.",
              },
            );
          const current = yield* sourceIdentity(sourceRoot);
          if (current.head !== identity.head || current.index !== identity.index)
            return yield* workspaceFailure(
              "create",
              "Source branch or index changed during snapshot acquisition.",
            );
          // Matched before the checkout, so too many matches refuse before it.
          const patterns = yield* readWorktreeInclude(sourceRoot);
          const included =
            patterns.length === 0
              ? []
              : yield* matchIncludedFiles(sourceRoot, repository, baseline, patterns);
          yield* setWorkspaceRef(repository, workspaceId, "baseline", baseline);
          record = { ...record, baseline };
          yield* saveWorkspaceRecord(registry, record);
          yield* addWorkspaceTree(record, sourceRoot, worker(record), baseline);
          const includedPaths = yield* copyIncludedFiles(
            "create",
            sourceRoot,
            worker(record),
            included,
          );
          if (includedPaths.length > 0) record = { ...record, includedPaths };
          yield* checkDirectory(handle.cwd);
          const ready: WorkspaceHandle = {
            ...handle,
            writerCwd: yield* canonicalizeWriterDirectory(handle.cwd).pipe(
              Effect.mapError((error) => workspaceFailure("create", error.message)),
            ),
          };
          yield* saveWorkspaceRecord(
            registry,
            { ...record, handle: ready, status: "active" },
            () => {
              handedOver = true;
              owned.add(workspaceId);
              input.onAcquired?.(ready);
            },
          );
          return ready;
        }).pipe(
          Effect.catchIf(
            (error) => !error.cleanupUnconfirmed,
            (error) =>
              removeCreated.pipe(
                Effect.matchEffect({
                  onSuccess: () =>
                    Effect.fail(withOutcome(error, "The partial workspace was removed.")),
                  onFailure: () =>
                    Effect.fail(withOutcome(error, `The partial workspace remains at ${dir}.`)),
                }),
              ),
          ),
          Effect.onInterrupt(() =>
            handedOver
              ? Effect.void
              : removeCreated.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      `Interrupted workspace creation left ${dir}: ${error.message}`,
                    ),
                  ),
                ),
          ),
        );
      });

    const create = Effect.fn("GitWorkspaceEngine.create")(function* (input: CreateWorkspaceInput) {
      yield* supportedGitInstallation;
      if (/\p{Cc}/u.test(registry))
        return yield* workspaceRefusal(
          "create",
          "The agent directory path can't hold workspaces.",
          {
            path: registry,
            rule: "workspace paths must not contain control characters such as newlines",
            remedy: "Move the Pi agent directory to a path without control characters.",
          },
        );
      const resolved = yield* workspaceIO("source", () => fs.realpath(input.sourceCwd));
      const named = input.sourceWorkspace;
      if (named === undefined) {
        if (withinTree(registry, resolved))
          return yield* workspaceRefusal(
            "create",
            "The session directory is inside private workspace storage.",
            {
              path: resolved,
              rule: "a workspace is created from private storage only from the worker tree of the workspace named as its source",
              remedy:
                "Start the writer from the real checkout, or have the worktree writer that owns this directory start it.",
            },
          );
        const source = yield* inspectSource(input.sourceCwd);
        yield* initializeWorkspaceStore(registry);
        return yield* lockedSource(source.sourceRoot, createInternal(input, source));
      }
      // Read before the lock only for its key and a precise refusal; it is rechecked under the lock.
      const unlocked = yield* readWorkspaceRecord(registry, named.workspaceId);
      if (!withinTree(worker(unlocked), resolved)) return yield* nestedSourceRefusal(resolved);
      const source = yield* inspectSource(input.sourceCwd);
      return yield* lockedSource(
        workspaceCheckoutRoot(unlocked.handle),
        Effect.gen(function* () {
          const parent = yield* checked(named);
          if (parent.status !== "active")
            return yield* workspaceRefusal("create", "The source workspace isn't active.", {
              path: source.sourceCwd,
              rule: "a nested workspace snapshots only an active workspace's worker tree",
              remedy: "Revise the source workspace to reopen it, or start from the real checkout.",
            });
          if (source.sourceRoot !== worker(parent) || !withinTree(worker(parent), source.sourceCwd))
            return yield* nestedSourceRefusal(source.sourceCwd);
          let links = 0;
          for (let link = parent; link.handle.sourceWorkspaceId !== undefined; ) {
            links += 1;
            if (links >= MAX_WORKSPACE_NESTING)
              return yield* workspaceRefusal("create", "Workspaces are nested too deeply.", {
                path: source.sourceCwd,
                rule: `at most ${MAX_WORKSPACE_NESTING} workspaces may separate a nested workspace from its real checkout`,
                remedy: "Integrate nested work into its source workspace before starting another.",
              });
            link = yield* readWorkspaceRecord(registry, link.handle.sourceWorkspaceId);
          }
          return yield* createInternal(input, {
            ...source,
            sourceWorkspaceId: parent.handle.workspaceId,
            checkoutRoot: workspaceCheckoutRoot(parent.handle),
          });
        }),
      );
    });
    // Captures the active worker tree as the record's revision, committing its patch first.
    const freezeRecord = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const { repository } = record;
        const { workspaceId } = record.handle;
        const snapshot = yield* captureWorker(record);
        const revisionId = yield* commitTree(
          repository,
          snapshot.tree,
          [record.baseline],
          "revision",
        );
        yield* setWorkspaceRef(repository, workspaceId, "revision", revisionId);
        const changes = yield* changedEntries(repository, record.baseline, revisionId);
        if (
          changes.some((change) => unpublishableMode(change.from) || unpublishableMode(change.to))
        )
          return yield* workspaceFailure(
            "freeze",
            "Creating, removing or changing symlinks or submodules is unsupported. Existing links and submodules must remain unchanged.",
          );
        const changedPaths = changes.map((change) => change.path);
        // The patch is kept beside the record, never inside it.
        const diff = yield* commitRevisionPatch(registry, record, revisionId, "freeze");
        const frozen = {
          revisionId,
          changedPaths,
          ...(snapshot.droppedPaths.length > 0 && { uncapturedPaths: snapshot.droppedPaths }),
        };
        const { rebasedTree: _rebasedTree, ...unprovisioned } = record;
        const next: WorkspaceRecord = { ...unprovisioned, status: "frozen", revision: frozen };
        yield* saveWorkspaceRecord(registry, next);
        return { record: next, revision: { ...frozen, diff } satisfies WorkspaceRevision };
      });
    const freeze = Effect.fn("GitWorkspaceEngine.freeze")(function* (
      target: WorkspaceSettledTarget,
    ) {
      yield* settled(target);
      const record = yield* checked(target);
      if (record.status !== "active")
        return yield* workspaceFailure(
          "freeze",
          "Only active workspaces may be frozen; revise explicitly first.",
        );
      return (yield* freezeRecord(record)).revision;
    }, locked);
    const revisionWithDiff = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const frozen = record.revision;
        if (frozen === undefined) return undefined;
        const bytes = yield* readRevisionDiff(registry, record.handle.workspaceId);
        return { ...frozen, diff: revisionText(bytes) } satisfies WorkspaceRevision;
      });

    // Runs plumbing against a temporary index in the workspace's directory, never the real one.
    const withScratchIndex = <A, E, R>(
      record: WorkspaceRecord,
      use: (environment: { readonly GIT_INDEX_FILE: string }) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const index = path.join(directory(record), `${yield* newWorkspaceId}.index`);
        return yield* use({ GIT_INDEX_FILE: index }).pipe(
          Effect.ensuring(
            workspaceIO("index", () => fs.rm(index, { force: true })).pipe(Effect.ignore),
          ),
        );
      });

    // The baseline with `paths` taken from the revision: once a partial integration publishes
    // them, they are no longer changes, and the next freeze proposes only the rest.
    const advancedBaseline = (
      record: WorkspaceRecord,
      revisionId: string,
      paths: ReadonlyArray<string>,
    ) =>
      withScratchIndex(record, (environment) =>
        Effect.gen(function* () {
          const { repository } = record;
          const entries = yield* treeEntries(repository, revisionId);
          const encoder = new TextEncoder();
          const updates = paths.flatMap((name) => {
            const entry = entries.get(name);
            return entry ? [`${entry.mode} ${entry.oid}\t${name}\0`] : [];
          });
          const removals = paths.flatMap((name) => (entries.has(name) ? [] : [`${name}\0`]));
          yield* repositoryGit(repository, ["read-tree", record.baseline], { environment });
          if (updates.length > 0)
            yield* repositoryGit(repository, ["update-index", "-z", "--index-info"], {
              stdin: encoder.encode(updates.join("")),
              environment,
            });
          if (removals.length > 0)
            yield* repositoryGit(repository, ["update-index", "-z", "--force-remove", "--stdin"], {
              stdin: encoder.encode(removals.join("")),
              environment,
            });
          const tree = yield* repositoryGit(repository, ["write-tree"], { environment }).pipe(
            Effect.flatMap(oid),
          );
          return yield* commitTree(repository, tree, [record.baseline], "baseline");
        }),
      );
    // The parent's captured files with the patch applied, as Git objects: the patch meets the
    // repository's form of each file, whatever filters and line endings checkouts use.
    const combinedTree = (
      record: WorkspaceRecord,
      parent: string,
      patch: Uint8Array,
      changed: ReadonlyArray<string>,
    ) =>
      withScratchIndex(record, (environment) =>
        Effect.gen(function* () {
          const { repository } = record;
          yield* repositoryGit(repository, ["read-tree", parent], { environment });
          if (patch.length > 0) {
            const checkArgs = ["apply", "--cached", "--check", "--whitespace=nowarn", "-"];
            const check = yield* repositoryGitResult(repository, checkArgs, {
              stdin: patch,
              environment,
            });
            if (!gitSucceeded(check))
              return yield* check.code !== null && !check.cleanupUnconfirmed
                ? applyConflict(check, changed)
                : gitFailure(checkArgs, check);
            yield* repositoryGit(repository, ["apply", "--cached", "--whitespace=nowarn", "-"], {
              stdin: patch,
              environment,
            });
          }
          return yield* repositoryGit(repository, ["write-tree"], { environment }).pipe(
            Effect.flatMap(oid),
          );
        }),
      );
    const prepare = Effect.fn("GitWorkspaceEngine.prepare")(function* (
      target: WorkspacePreparationTarget,
    ) {
      const record = yield* checked(target);
      const reviewed = yield* revision(record, target.revisionId);
      if (record.status !== "frozen" && record.status !== "prepared")
        return yield* workspaceFailure("prepare", "Workspace is not awaiting integration.");
      const paths = yield* preparationPaths(reviewed, target.paths);
      const selected = paths ?? reviewed.changedPaths;
      yield* openSourceWorkspace(record, "prepare");
      const { repository } = record;
      const { sourceRoot } = record.handle;
      yield* refuseHiddenLocalEdits(sourceRoot, "prepare", selected);
      const workerTree = yield* captureWorker(record);
      if (workerTree.tree !== (yield* treeOf(repository, target.revisionId)))
        return yield* workspaceFailure(
          "prepare",
          "Worker changed after review; freeze a new revision.",
        );
      const identity = yield* sourceIdentity(sourceRoot);
      const head = yield* headCommit(sourceRoot);
      const parent = yield* captureSource(record);
      const parentCommit = yield* commitTree(repository, parent.tree, [head], "parent");
      const parentEntries = yield* treeEntries(repository, parentCommit);
      if (selected.some((name) => unpublishableMode(parentEntries.get(name)?.mode ?? "")))
        return yield* workspaceFailure(
          "prepare",
          "A changed path is now a source symlink or submodule; integration refused.",
        );
      // A partial preparation applies only its paths' sections of the revision's patch.
      const patch =
        paths === undefined
          ? yield* readRevisionDiff(registry, target.workspaceId)
          : yield* patchBytes(
              registry,
              record,
              { from: record.baseline, to: target.revisionId },
              "prepare",
              paths,
            );
      const combined = yield* combinedTree(record, parentCommit, patch, selected);
      const preparedCommit = yield* commitTree(repository, combined, [parentCommit], "prepared");
      yield* setWorkspaceRef(repository, target.workspaceId, "prepared", preparedCommit);
      const preparationId = yield* newWorkspaceId;
      const preparedRoot = prepared(record, preparationId);
      // A failed preparation never becomes integrable, so its copy of the source goes too; a
      // Git process whose cleanup is uncertain keeps the tree for manual recovery.
      let committed = false;
      return yield* Effect.gen(function* () {
        yield* addWorkspaceTree(record, sourceRoot, preparedRoot, preparedCommit);
        // The parent's current copies, so the tested tree runs with the parent's local files.
        yield* copyIncludedFiles("prepare", sourceRoot, preparedRoot, record.includedPaths ?? []);
        const leaseDirectories = yield* requiredLeaseDirectories(record, selected);
        const result = {
          preparationId,
          revisionId: target.revisionId,
          cwd: path.join(preparedRoot, subdirectory(record)),
          leaseDirectories,
          ...(paths !== undefined && { paths }),
        };
        yield* checkDirectory(result.cwd);
        yield* saveWorkspaceRecord(
          registry,
          {
            ...record,
            status: "prepared",
            preparation: result,
            parentTree: parent.tree,
            preparedTree: combined,
            sourceHead: identity.head,
            sourceIndex: identity.index,
          },
          () => {
            committed = true;
          },
        );
        return result;
      }).pipe(
        Effect.catchIf(
          (error) => !error.cleanupUnconfirmed,
          (error) => removeUnhanded(record, preparationId).pipe(Effect.andThen(Effect.fail(error))),
        ),
        Effect.onInterrupt(() => (committed ? Effect.void : removeUnhanded(record, preparationId))),
      );
    }, locked);

    const integrate = Effect.fn("GitWorkspaceEngine.integrate")(function* (
      target: WorkspaceIntegrationTarget,
    ) {
      yield* settled(target);
      const record = yield* checked(target);
      const reviewed = yield* revision(record, target.revisionId);
      const preparation = record.preparation;
      if (
        record.status !== "prepared" ||
        preparation === undefined ||
        preparation.preparationId !== target.preparationId ||
        !validWorkspaceId(target.preparationId)
      )
        return yield* workspaceFailure("integrate", "Tested preparation is stale or unknown.");
      yield* openSourceWorkspace(record, "integrate");
      const { repository } = record;
      const { sourceRoot } = record.handle;
      // Rechecked here, since a bit set after preparation hides edits made since.
      yield* refuseHiddenLocalEdits(
        sourceRoot,
        "integrate",
        preparation.paths ?? reviewed.changedPaths,
      );
      const reviewedTree = yield* treeOf(repository, target.revisionId);
      const workerTree = yield* captureWorker(record);
      const preparedRoot = prepared(record, target.preparationId);
      const preparedTree = yield* captureWorker(
        record,
        preparedRoot,
        record.preparedTree ?? record.baseline,
      );
      const before = yield* captureSource(record);
      const identity = yield* sourceIdentity(sourceRoot);
      if (
        workerTree.tree !== reviewedTree ||
        preparedTree.tree !== record.preparedTree ||
        record.parentTree === undefined ||
        identity.head !== record.sourceHead ||
        identity.index !== record.sourceIndex
      )
        return yield* workspaceFailure(
          "integrate",
          "Worker, test tree, source branch or index changed; review and test again.",
        );
      // Parent edits to files the proposal doesn't touch are kept as they are; edits to a touched
      // file would be overwritten or merged untested, so they refuse.
      const drifted =
        before.tree === record.parentTree
          ? []
          : yield* changedBetween(repository, record.parentTree, before.tree);
      // A partial preparation publishes only its paths; the rest stay the workspace's proposal.
      const selected = preparation.paths ?? reviewed.changedPaths;
      const touched = new Set(selected);
      const touchedDrift = drifted.filter((name) => touched.has(name));
      if (touchedDrift.length > 0) return yield* touchedParentDrift(touchedDrift);
      const untouchedDriftPaths = drifted.filter((name) => !touched.has(name));
      const required = yield* requiredLeaseDirectories(record, selected);
      if (required.some((ancestor) => !preparation.leaseDirectories.includes(ancestor)))
        return yield* workspaceFailure(
          "integrate",
          "Changed-file ancestors changed; prepare and test again before integration.",
        );
      // Publication works on the bytes on disk: the parent's current files and the tested
      // tree's checkout of the proposal. A parent file the capture left out, such as an ignored
      // one, would be replaced untested, so it refuses like a drifted file.
      const previous = yield* readPublishedFiles(sourceRoot, selected);
      const captured = yield* treeEntries(repository, before.tree);
      const hidden = selected.filter((name) => previous.has(name) !== captured.has(name));
      if (hidden.length > 0) return yield* touchedParentDrift(hidden);
      const next = yield* readPublishedFiles(preparedRoot, selected);
      // Read before publication, so a failure can't follow the commit. No child can appear
      // meanwhile: its creation takes this chain's lock.
      const partialBaseline =
        preparation.paths === undefined
          ? undefined
          : yield* advancedBaseline(record, target.revisionId, selected);
      if (partialBaseline !== undefined)
        // The worker's HEAD keeps the previous baseline reachable meanwhile.
        yield* setWorkspaceRef(repository, target.workspaceId, "baseline", partialBaseline);
      const retainedForChildren =
        target.retainTrees || partialBaseline !== undefined
          ? []
          : yield* unresolvedChildWorkspaces(registry, target.workspaceId);
      // Only the proposal's own changes are published, so untouched parent edits stay.
      const changed = selected.filter((name) => {
        const current = previous.get(name),
          published = next.get(name);
        return current?.digest !== published?.digest || current?.mode !== published?.mode;
      });
      const publication = yield* publishWorkspace(
        registry,
        record,
        previous,
        next,
        changed,
        preparation,
      );
      const after = yield* sourceIdentity(record.handle.sourceRoot);
      // Every file is already written, so the record stays mid-integration with its journal and
      // every backup; discard rolls the files back once the user has reconciled the branch or index.
      if (after.head !== identity.head || after.index !== identity.index) {
        const changedParts = [
          ...(after.head === identity.head ? [] : ["HEAD"]),
          ...(after.index === identity.index ? [] : ["index"]),
        ];
        return yield* publishedMidIntegration(
          registry,
          publication.record,
          `The source ${changedParts.join(" and ")} changed during publication; the workspace stays mid-integration.`,
          "inspect the source branch and staged changes, then discard the workspace to roll the published files back, or keep them and delete the backups manually.",
        );
      }
      if (partialBaseline !== undefined) {
        // The worker keeps every change; the advanced baseline makes the rest its proposal. Like an
        // integrated record, it keeps the journal that names this publication's backups.
        const {
          revision: _revision,
          preparation: _preparation,
          preparedTree: _preparedTree,
          parentTree: _parentTree,
          sourceHead: _sourceHead,
          sourceIndex: _sourceIndex,
          ...kept
        } = publication.record;
        const reopened: WorkspaceRecord = { ...kept, status: "active", baseline: partialBaseline };
        yield* commitPublication(registry, publication.record, reopened);
        yield* finishPublication(registry, reopened);
        const remainingBackupPaths = yield* removePublicationBackups(publication.backups);
        yield* removeEmptiedDirectories(publication.emptiedDirectories);
        if (!target.retainTrees) yield* removePreparation(reopened, target.preparationId);
        return {
          record: reopened,
          workerRoot: worker(record),
          untouchedDriftPaths,
          treeRemovalFailed: false,
          remainingBackupPaths,
          remainingPaths: reviewed.changedPaths.filter((name) => !touched.has(name)),
        };
      }
      const integrated: WorkspaceRecord = { ...publication.record, status: "integrated" };
      yield* commitPublication(registry, publication.record, integrated);
      yield* finishPublication(registry, integrated);
      const remainingBackupPaths = yield* removePublicationBackups(publication.backups);
      yield* removeEmptiedDirectories(publication.emptiedDirectories);
      const treeRemovalFailed = target.retainTrees
        ? false
        : yield* removeWorkspaceTrees(registry, integrated, {
            keepWorker: retainedForChildren.length > 0,
            beforeRemove,
          }).pipe(
            Effect.as(false),
            Effect.catchTag("WorkspaceError", (error) =>
              Effect.logWarning(`Integrated workspace trees remain on disk: ${error.message}`).pipe(
                Effect.annotateLogs("workspaceId", target.workspaceId),
                Effect.as(true),
              ),
            ),
          );
      return {
        record: integrated,
        workerRoot: worker(record),
        untouchedDriftPaths,
        treeRemovalFailed,
        remainingBackupPaths,
        ...(retainedForChildren.length > 0 && { retainedForChildren }),
      };
    }, locked);

    const revise = Effect.fn("GitWorkspaceEngine.revise")(function* (
      target: WorkspaceSettledTarget,
    ) {
      yield* settled(target);
      const record = yield* checked(target);
      if (!["active", "frozen", "prepared"].includes(record.status))
        return yield* workspaceFailure(
          "revise",
          "Workspace cannot be reopened in its current state.",
        );
      const next: WorkspaceRecord = {
        version: 2,
        handle: record.handle,
        repository: record.repository,
        baseline: record.baseline,
        ownerLease: record.ownerLease,
        status: "active",
        ...(record.launch && { launch: record.launch }),
        ...(record.includedPaths && { includedPaths: record.includedPaths }),
      };
      yield* saveWorkspaceRecord(registry, next);
      return next.handle;
    }, locked);
    const discardInternal = (target: WorkspaceSettledTarget) =>
      Effect.gen(function* () {
        yield* settled(target);
        const record = yield* checked(target);
        yield* refuseWithChildren(record);
        // A stopped publication is undone first; until that succeeds the record stays mid-integration.
        if (record.status === "integrating") yield* rollbackPublication(registry, record);
        yield* removeWorkspaceTrees(registry, record, { beforeRemove });
        yield* saveWorkspaceRecord(registry, { ...record, status: "discarded" });
        owned.delete(target.workspaceId);
        return undefined;
      });
    const discard = (target: WorkspaceSettledTarget) => locked(discardInternal(target), target);
    const { discardOrphan, adopt, endedOwners, sweepCandidates, sweepOrphan } =
      orphanWorkspaceOperations({
        registry,
        locks,
        lockDirectory,
        owned,
        ownerPresence,
        managedRecord,
        refuseWithChildren,
        workerTree: (record) => captureWorker(record).pipe(Effect.map(({ tree }) => tree)),
        freezeAnew: (record) =>
          freezeRecord({ ...withoutPreparation(record), status: "active" }).pipe(
            Effect.map((frozen) => frozen.record),
          ),
        beforeRemove,
        locked,
      });
    const rebase = Effect.fn("GitWorkspaceEngine.rebase")(function* (
      target: WorkspaceSettledTarget,
    ) {
      yield* settled(target);
      return yield* rebaseWorkspace(registry, yield* checked(target), managedRecord, beforeRemove);
    }, locked);
    const collectGarbage = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* collectWorkspaceRecords(registry, {
        now,
        owned: (workspaceId) => owned.has(workspaceId),
        whenSourceFree: (sourceRoot, effect) =>
          withFreeLock(locks, lockDirectory, sourceLockNamespace(sourceRoot), effect),
        whenOwnerEnded: (ownerLease, effect) =>
          withFreeLock(locks, lockDirectory, ownerLockNamespace(ownerLease), effect),
        beforeRemove,
      });
    });
    const hookTree = (record: WorkspaceRecord, preparation: string | undefined) =>
      preparation === undefined ? worker(record) : prepared(record, preparation);
    // Persist before spawning. Uncertain cleanup or a failed record commit keeps this proof missing
    // across runtime replacement; neither caller cleanup nor orphan discard can erase it, and every
    // other operation refuses the record while it is set.
    const beginCreateHooks = Effect.fn("GitWorkspaceEngine.beginCreateHooks")(function* (
      target: WorkspaceHookTarget,
      began: (root: string) => void,
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (
        preparation === undefined
          ? record.status !== "active"
          : record.status !== "prepared" || record.preparation?.preparationId !== preparation
      )
        return yield* workspaceFailure("hook", "The hook's tree is stale or unavailable.");
      const root = hookTree(record, preparation);
      // A failed save may still have renamed the marker into place.
      yield* saveWorkspaceRecord(registry, { ...record, setupCleanupPending: root }, () =>
        began(root),
      ).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceError({
              operation: "hook",
              message:
                "WorktreeCreate couldn't record its quarantine marker; the artifact may stay quarantined.",
              detail: [error.message, error.detail, `Hook tree: ${root}`]
                .filter((line) => line !== undefined)
                .join("\n"),
              cleanupUnconfirmed: true,
            }),
        ),
      );
      return { root, sourceCwd: record.handle.sourceCwd };
    }, locked);
    // Clears the marker only after confirmed process cleanup, optionally withdrawing the
    // preparation so its untested tree can never be integrated.
    const finishCreateHooks = Effect.fn("GitWorkspaceEngine.finishCreateHooks")(function* (
      target: WorkspaceHookTarget,
      root: string,
      withdraw: boolean,
    ) {
      const record = yield* readWorkspaceRecord(registry, target.workspaceId);
      if (record.setupCleanupPending !== root || record.handle.ownerId !== target.ownerId)
        return yield* workspaceFailure("hook", "The hook quarantine record changed.");
      const cleared = withoutHookMarker(record);
      const preparation = target.preparationId;
      if (!withdraw || preparation === undefined)
        return yield* saveWorkspaceRecord(registry, cleared);
      yield* saveWorkspaceRecord(registry, withoutPreparation(cleared));
      yield* removePreparation(cleared, preparation);
      return undefined;
    }, locked);
    /**
     * Runs the WorktreeCreate hooks in order, stopping at the first failure. They can run for up
     * to an hour each, so they hold neither this process's operation gate nor the checkout's store
     * lock; the durable marker keeps every other operation away. Once the runner confirms every
     * process group stopped, including after interruption, the marker is cleared uninterruptibly
     * before the outcome propagates; otherwise the artifact stays quarantined. A failed or
     * interrupted run in a prepared tree withdraws the preparation.
     */
    const runCreateHooks = (
      target: WorkspaceHookTarget & {
        readonly hooks: ReadonlyArray<WorktreeHook>;
        readonly runId?: string | undefined;
      },
    ) => {
      let marked: string | undefined;
      // False once any hook's process group couldn't be confirmed stopped.
      let cleanupConfirmed = true;
      const finish = (root: string, failed: boolean, failure: WorkspaceError | undefined) =>
        gate(finishCreateHooks(target, root, failed)).pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({
                operation: "hook",
                message:
                  "WorktreeCreate hooks stopped, but their quarantine couldn't be cleared; the artifact stays quarantined.",
                detail: [failure?.message, error.message, error.detail, `Hook tree: ${root}`]
                  .filter((line) => line !== undefined)
                  .join("\n"),
                cleanupUnconfirmed: true,
              }),
          ),
        );
      const run = (root: string, sourceCwd: string) =>
        Effect.forEach(
          target.hooks,
          (hook) =>
            runWorktreeHook(
              hook,
              {
                event: "WorktreeCreate",
                workspaceId: target.workspaceId,
                worktreePath: root,
                sourceCwd,
                kind: worktreeKind(root),
                runId: target.runId,
              },
              {
                onCleanup: (confirmed) => {
                  if (!confirmed) cleanupConfirmed = false;
                },
              },
            ).pipe(
              Effect.mapError(
                (error) =>
                  new WorkspaceError({
                    operation: "hook",
                    message: error.message,
                    ...(error.cleanupUnconfirmed && { cleanupUnconfirmed: true }),
                  }),
              ),
            ),
          { discard: true },
        );
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* restore(
            gate(
              beginCreateHooks(target, (root) => {
                marked = root;
                settingUp.add(target.workspaceId);
              }),
            ).pipe(Effect.flatMap(({ root, sourceCwd }) => run(root, sourceCwd))),
          ).pipe(Effect.exit);
          const root = marked;
          // Refused before marking the tree, so no hook ran.
          if (root === undefined) return yield* exit;
          if (Exit.isSuccess(exit)) return yield* finish(root, false, undefined);
          if (Cause.hasInterrupts(exit.cause)) {
            if (cleanupConfirmed)
              yield* finish(root, true, undefined).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`Interrupted WorktreeCreate hooks: ${error.message}`).pipe(
                    Effect.annotateLogs("workspaceId", target.workspaceId),
                  ),
                ),
              );
            return yield* exit;
          }
          const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
          if (failure?.cleanupUnconfirmed !== true) yield* finish(root, true, failure);
          return yield* exit;
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (marked !== undefined) settingUp.delete(target.workspaceId);
          }),
        ),
        Effect.withSpan("GitWorkspaceEngine.runCreateHooks"),
      );
    };
    // Compares the worker tree with its baseline, storing no commit.
    const workerChanges = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const snapshot = yield* captureWorker(record);
        const changedPaths =
          snapshot.tree === (yield* treeOf(record.repository, record.baseline))
            ? []
            : yield* changedBetween(record.repository, record.baseline, snapshot.tree);
        return { snapshot, changedPaths };
      });
    // WorktreeCreate hooks may only add ignored files such as dependencies (or credential files,
    // which captures leave out); anything else would enter the worker's proposal or invalidate
    // the prepared tree.
    const hookChanges = Effect.fn("GitWorkspaceEngine.hookChanges")(function* (
      target: WorkspaceHookTarget,
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (preparation === undefined) {
        if (record.status !== "active")
          return yield* workspaceFailure("hook", "Only an active workspace's worker runs hooks.");
        if (record.rebasedTree === undefined) return (yield* workerChanges(record)).changedPaths;
        // A rebuilt worker already differs from its baseline by the reapplied changes.
        const snapshot = yield* captureWorker(record);
        if (snapshot.tree === record.rebasedTree) return [];
        return yield* changedBetween(record.repository, record.rebasedTree, snapshot.tree);
      }
      if (
        record.status !== "prepared" ||
        record.preparation?.preparationId !== preparation ||
        record.preparedTree === undefined
      )
        return yield* workspaceFailure("hook", "Preparation is stale or unknown.");
      const snapshot = yield* captureWorker(
        record,
        prepared(record, preparation),
        record.preparedTree,
      );
      if (snapshot.tree === record.preparedTree) return [];
      return yield* changedBetween(record.repository, record.preparedTree, snapshot.tree);
    }, locked);
    // Captures the worker tree like freeze, but records no revision.
    const inspectWorkerChanges = Effect.fn("GitWorkspaceEngine.inspectWorkerChanges")(function* (
      target: WorkspaceSettledTarget,
    ) {
      yield* settled(target);
      const record = yield* checked(target);
      if (!["active", "frozen", "prepared"].includes(record.status))
        return yield* workspaceFailure("inspect", "The worker tree is no longer available.");
      const { snapshot, changedPaths } = yield* workerChanges(record);
      return {
        changedPaths,
        uncapturedPaths: snapshot.droppedPaths,
        diffStat:
          changedPaths.length === 0
            ? []
            : yield* diffStat(record.repository, record.baseline, snapshot.tree),
      } satisfies WorkspaceWorkerChanges;
    }, locked);
    const inspect = (target: WorkspaceTarget) => checked(target, false);
    // Reading takes no lock: freeze commits the patch file before the record that names it.
    const currentRevision = (target: WorkspaceTarget) =>
      checked(target, false).pipe(Effect.flatMap(revisionWithDiff));
    const unresolvedChildren = (target: WorkspaceOrphanTarget) =>
      unresolvedChildWorkspaces(registry, target.workspaceId);
    const hookCleanupPending = (target: WorkspaceOrphanTarget) =>
      readWorkspaceRecord(registry, target.workspaceId).pipe(
        Effect.map((record) => record.setupCleanupPending !== undefined),
      );
    const listRecords = listWorkspaceRecords(registry);
    const listAll = listRecords.pipe(
      Effect.flatMap(
        (listing): Effect.Effect<WorkspaceListing, WorkspaceError, SafeFile> =>
          endedOwners(listing.records).pipe(
            Effect.map((ended) =>
              ended.length > 0 ? { ...listing, endedOwners: ended } : listing,
            ),
          ),
      ),
    );
    const list = (input: { readonly ownerId: string }) =>
      listWorkspaceRecords(registry).pipe(
        Effect.map(({ records }) =>
          records.filter((record) => record.handle.ownerId === input.ownerId),
        ),
      );
    return {
      create,
      freeze,
      prepare,
      integrate,
      revise,
      rebase,
      discard,
      discardOrphan,
      adopt,
      sweepCandidates,
      sweepOrphan,
      collectGarbage,
      runCreateHooks,
      hookChanges,
      inspectWorkerChanges,
      inspect,
      revision: currentRevision,
      unresolvedChildren,
      hookCleanupPending,
      list,
      listRecords,
      listAll,
    };
  });
