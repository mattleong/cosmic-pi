import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CrossProcessLock, type CrossProcessLease, type SafeFile } from "pi-cosmic-core";
import type { WorktreeHook } from "../config/schema.ts";
import { OPEN_WORKSPACE_STATUSES, WorkspaceError } from "../workspace/model.ts";
import { canonicalizeWriterDirectory } from "./writer-lease.ts";
import { runWorktreeHook } from "./worktree-hook.ts";
import { worktreeKind, worktreeRemoveHooks } from "./git-worktree-hooks.ts";
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
import { commitRevisionPatch, revisionText } from "./git-worktree-patch.ts";
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
  removeWorkspaceTrees,
} from "./git-worktree-recovery.ts";
import {
  commitPublication,
  finishPublication,
  publishedMidIntegration,
  publicationBudget,
  publishWorkspace,
  readPublishedFiles,
  refuseOversizedPublication,
  removeEmptiedDirectories,
  removePublicationBackups,
  requiredLeaseDirectories,
  rollbackPublication,
  touchedParentDrift,
} from "./git-worktree-integration.ts";

const subdirectory = workspaceSubdirectory;

// Publication installs regular files only, so freeze refuses links and submodules that change.
const unpublishableMode = (mode: string) => mode === "120000" || mode === "160000";

interface CreateWorkspaceInput {
  readonly sourceCwd: string;
  readonly ownerId: string;
  readonly launch?: WorkspaceLaunch | undefined;
  readonly onAcquired?: WorkspaceAcquired | undefined;
}

const withinTree = (tree: string, target: string) =>
  target === tree || target.startsWith(`${tree}${path.sep}`);

const settled = (target: WorkspaceSettledTarget) =>
  target.processCleanupConfirmed
    ? Effect.void
    : Effect.fail(workspaceFailure("cleanup", "Process cleanup must be independently confirmed."));

// Failed WorktreeCreate hooks in a prepared tree leave the reviewed revision frozen, with nothing to integrate.
const withoutPreparation = ({
  preparation: _preparation,
  parentTree: _parentTree,
  preparedTree: _preparedTree,
  sourceHead: _sourceHead,
  sourceIndex: _sourceIndex,
  ...record
}: WorkspaceRecord): WorkspaceRecord => ({ ...record, status: "frozen" });

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
    const beforeRemove = worktreeRemoveHooks(options.worktreeRemove ?? []);
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
    const captureSource = (record: WorkspaceRecord) =>
      captureTree(record.handle.sourceRoot, directory(record), sourceLeftOut, []);
    const managedRecord = (workspaceId: string) =>
      Effect.gen(function* () {
        const record = yield* readWorkspaceRecord(registry, workspaceId);
        const relative = subdirectory(record);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          record.handle.artifactRoot !== directory(record) ||
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
      removePreparationTree(registry, record, preparationId).pipe(Effect.asVoid);
    // Lock order: an operation holds at most one store lock, keyed by its record's source
    // checkout. Owner leases (orphan discard) are only taken inside it.
    const lockedSource = <A, E, R>(sourceRoot: string, effect: Effect.Effect<A, E, R>) =>
      withWorkspaceStoreLock(locks, lockDirectory, sourceRoot, effect);
    // The source root never changes for a record, so reading it before the lock is safe; the
    // operation itself rereads the record under the lock.
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>, target: WorkspaceOrphanTarget) =>
      readWorkspaceRecord(registry, target.workspaceId).pipe(
        Effect.flatMap((record) => lockedSource(record.handle.sourceRoot, effect)),
      );

    const createInternal = (input: CreateWorkspaceInput, source: SourceCheckout) =>
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
          artifactRoot: dir,
          cwd: path.join(dir, "worker", source.subdirectory),
        };
        let record: WorkspaceRecord = {
          version: 2,
          handle,
          repository: source.repository,
          status: "creating",
          baseline: "",
          ownerLease: yield* ownerPresence,
          lastChangedAt: yield* Clock.currentTimeMillis,
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
      if (withinTree(registry, resolved))
        return yield* workspaceRefusal(
          "create",
          "The session directory is inside private workspace storage.",
          {
            path: resolved,
            rule: "a workspace snapshots a real checkout, never another workspace's tree",
            remedy: "Start the writer from the real checkout.",
          },
        );
      const source = yield* inspectSource(input.sourceCwd);
      yield* initializeWorkspaceStore(registry);
      return yield* lockedSource(source.sourceRoot, createInternal(input, source));
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
      const selected = reviewed.changedPaths;
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
      const patch = yield* readRevisionDiff(registry, target.workspaceId);
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
        yield* refuseOversizedPublication([sourceRoot, preparedRoot], selected);
        const result = {
          preparationId,
          revisionId: target.revisionId,
          cwd: path.join(preparedRoot, subdirectory(record)),
          leaseDirectories,
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
      const { repository } = record;
      const { sourceRoot } = record.handle;
      // Rechecked here, since a bit set after preparation hides edits made since.
      const selected = reviewed.changedPaths;
      yield* refuseHiddenLocalEdits(sourceRoot, "integrate", selected);
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
      // Both sides share one memory budget, refused before anything is published.
      const budget = publicationBudget();
      const previous = yield* readPublishedFiles(sourceRoot, selected, budget);
      const captured = yield* treeEntries(repository, before.tree);
      const hidden = selected.filter((name) => previous.has(name) !== captured.has(name));
      if (hidden.length > 0) return yield* touchedParentDrift(hidden);
      const next = yield* readPublishedFiles(preparedRoot, selected, budget);
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
      const integrated: WorkspaceRecord = { ...publication.record, status: "integrated" };
      yield* commitPublication(registry, publication.record, integrated);
      yield* finishPublication(registry, integrated);
      const remainingBackupPaths = yield* removePublicationBackups(publication.backups);
      yield* removeEmptiedDirectories(publication.emptiedDirectories);
      const treeRemovalFailed = target.retainTrees
        ? false
        : yield* removeWorkspaceTrees(registry, integrated, { beforeRemove }).pipe(
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
      };
    }, locked);

    const revise = Effect.fn("GitWorkspaceEngine.revise")(function* (
      target: WorkspaceSettledTarget,
    ) {
      yield* settled(target);
      const record = yield* checked(target);
      if (!OPEN_WORKSPACE_STATUSES.has(record.status))
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
        lastChangedAt: record.lastChangedAt,
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
      return yield* rebaseWorkspace(registry, yield* checked(target), beforeRemove);
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
    // The tree a WorktreeCreate run targets, checked under the locks before any hook starts.
    const createHookTree = Effect.fn("GitWorkspaceEngine.createHookTree")(function* (
      target: WorkspaceHookTarget,
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (
        preparation === undefined
          ? record.status !== "active"
          : record.status !== "prepared" || record.preparation?.preparationId !== preparation
      )
        return yield* workspaceFailure("hook", "The hook's tree is stale or unavailable.");
      return { root: hookTree(record, preparation), sourceCwd: record.handle.sourceCwd };
    }, locked);
    // Withdraws a preparation whose WorktreeCreate hooks failed or were interrupted, so its
    // untested tree can never be integrated.
    const withdrawPreparation = Effect.fn("GitWorkspaceEngine.withdrawPreparation")(function* (
      target: WorkspaceHookTarget,
      preparationId: string,
    ) {
      const record = yield* checked(target);
      if (record.status !== "prepared" || record.preparation?.preparationId !== preparationId)
        return undefined;
      const frozen = withoutPreparation(record);
      yield* saveWorkspaceRecord(registry, frozen);
      yield* removePreparation(frozen, preparationId);
      return undefined;
    }, locked);
    /**
     * Runs the WorktreeCreate hooks in order, stopping at the first failure. They can run for up
     * to an hour each, so they hold neither this process's operation gate nor the checkout's store
     * lock; the coordinator keeps the workspace busy meanwhile. The runner kills a hook's process
     * group once it times out or is interrupted, and a group it can't confirm stopped is a logged
     * warning. A failed or interrupted run in a prepared tree withdraws the preparation.
     */
    const runCreateHooks = (
      target: WorkspaceHookTarget & {
        readonly hooks: ReadonlyArray<WorktreeHook>;
        readonly runId?: string | undefined;
      },
    ) => {
      const run = (root: string, sourceCwd: string) =>
        Effect.forEach(
          target.hooks,
          (hook) =>
            runWorktreeHook(hook, {
              event: "WorktreeCreate",
              workspaceId: target.workspaceId,
              worktreePath: root,
              sourceCwd,
              kind: worktreeKind(root),
              runId: target.runId,
            }).pipe(
              Effect.tapError((error) =>
                error.cleanupUnconfirmed
                  ? Effect.logWarning(error.message).pipe(
                      Effect.annotateLogs({
                        workspaceId: target.workspaceId,
                        tree: root,
                        ...(target.runId !== undefined && { runId: target.runId }),
                      }),
                    )
                  : Effect.void,
              ),
              Effect.mapError(
                (error) => new WorkspaceError({ operation: "hook", message: error.message }),
              ),
            ),
          { discard: true },
        );
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { root, sourceCwd } = yield* restore(gate(createHookTree(target)));
          const exit = yield* restore(run(root, sourceCwd)).pipe(Effect.exit);
          const preparationId = target.preparationId;
          if (Exit.isFailure(exit) && preparationId !== undefined)
            yield* gate(withdrawPreparation(target, preparationId)).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `A preparation whose hooks failed remains: ${error.message}`,
                ).pipe(Effect.annotateLogs("workspaceId", target.workspaceId)),
              ),
            );
          return yield* exit;
        }),
      ).pipe(Effect.withSpan("GitWorkspaceEngine.runCreateHooks"));
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
      if (!OPEN_WORKSPACE_STATUSES.has(record.status))
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
      list,
      listRecords,
      listAll,
    };
  });
