import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CrossProcessLock, type CrossProcessLease } from "pi-cosmic-core";
import type { WorkspaceSetup } from "../config/schema.ts";
import { WorkspaceError } from "../workspace/model.ts";
import { canonicalizeWriterDirectory } from "./writer-lease.ts";
import { runWorkspaceSetup } from "./workspace-setup.ts";
import type {
  WorkspaceAcquired,
  WorkspaceHandle,
  WorkspaceIntegrationTarget,
  WorkspaceOrphanTarget,
  WorkspaceRecord,
  WorkspaceRevisionTarget,
  WorkspaceSettledTarget,
  WorkspaceSetupTarget,
  WorkspaceTarget,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  gitFields,
  oid,
  workspaceFailure,
  workspaceIO,
  workspaceRefusal,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";
import { supportedGitInstallation } from "./git-installation.ts";
import { captureSnapshot, inspectSource, sourceIdentity } from "./git-worktree-snapshot.ts";
import {
  initializeWorkspaceStore,
  newWorkspaceId,
  readWorkspaceRecord,
  saveWorkspaceRecord,
  syncWorkspaceDirectory,
  validWorkspaceId,
  workspaceDirectory,
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
  publishWorkspace,
  removePublicationBackups,
  requiredLeaseDirectories,
} from "./git-worktree-integration.ts";

const ownerNamespace = (token: string) => `workspace-owner:${token}`;

const treeOf = (repository: string, revision: string) =>
  git(repository, ["rev-parse", `${revision}^{tree}`]).pipe(Effect.flatMap(oid));
const subdirectory = (record: WorkspaceRecord) =>
  path.relative(record.handle.sourceRoot, record.handle.sourceCwd);

interface SourceCheckout {
  readonly sourceRoot: string;
  readonly sourceCwd: string;
  readonly subdirectory: string;
}

interface CreateWorkspaceInput {
  readonly sourceCwd: string;
  readonly ownerId: string;
  readonly onAcquired?: WorkspaceAcquired | undefined;
}

const settled = (target: WorkspaceSettledTarget) =>
  target.processCleanupConfirmed
    ? Effect.void
    : Effect.fail(workspaceFailure("cleanup", "Process cleanup must be independently confirmed."));

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
    Effect.map((root) => path.join(root, "git-workspaces")),
  );

const ATTRIBUTE_OVERRIDES =
  "* !text !eol !crlf !filter !ident !working-tree-encoding !diff !merge\n";

// $GIT_DIR/info/attributes outranks every .gitattributes file, so checkout, apply and diff in the
// private repository and its worktrees stay byte-exact and never run a filter or driver.
const neutralizeAttributes = (repository: string) =>
  Effect.gen(function* () {
    const info = path.join(repository, "info");
    yield* workspaceIO("create", () => fs.mkdir(info, { mode: 0o700 }));
    yield* writeWorkspaceFile(
      path.join(info, "attributes"),
      new TextEncoder().encode(ATTRIBUTE_OVERRIDES),
      0o600,
    );
  });

/** The engine for `registry` (see workspaceRegistry); CrossProcessLock must use its lock directory. */
export const gitWorkspaceEngine = (registry: string) =>
  Effect.gen(function* () {
    const lockDirectory = workspaceLockDirectory(registry);
    const locks = yield* CrossProcessLock;
    const owned = new Set<string>();
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
        .tryAcquire(ownerNamespace(token))
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
    const directory = (record: WorkspaceRecord) =>
      workspaceDirectory(registry, record.handle.workspaceId);
    const repository = (record: WorkspaceRecord) => path.join(directory(record), "repo.git");
    const worker = (record: WorkspaceRecord) => path.join(directory(record), "worker");
    const capture = (
      record: WorkspaceRecord,
      root: string,
      reference: string,
      scanNewContent = false,
    ) =>
      Effect.gen(function* () {
        const requiredPaths = record.baseline
          ? yield* gitFields(repository(record), [
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              record.baseline,
            ])
          : [];
        if (record.revision) requiredPaths.push(...record.revision.changedPaths);
        return yield* captureSnapshot(root, repository(record), reference, {
          requiredPaths,
          scanNewContent,
        });
      });
    const managedRecord = (workspaceId: string) =>
      Effect.gen(function* () {
        const record = yield* readWorkspaceRecord(registry, workspaceId);
        if (record.setupCleanupPending !== undefined)
          return yield* new WorkspaceError({
            operation: "setup",
            message: "Workspace setup cleanup is unconfirmed; the artifact is quarantined.",
            detail: `Setup tree: ${record.setupCleanupPending}\nIndependently confirm the setup process and every descendant have stopped. Preserve the proposal and recovery record before manually recovering the private trees; restarting Pi does not clear this quarantine.`,
            cleanupUnconfirmed: true,
          });
        const relative = subdirectory(record);
        if (
          relative.startsWith("..") ||
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
    const lockedSource = <A, E, R>(sourceRoot: string, effect: Effect.Effect<A, E, R>) =>
      withWorkspaceStoreLock(locks, lockDirectory, sourceRoot, effect);
    // The source root never changes for a record, so reading it before the lock is safe; the
    // operation itself rereads the record under the lock.
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>, target: WorkspaceOrphanTarget) =>
      readWorkspaceRecord(registry, target.workspaceId).pipe(
        Effect.flatMap((record) => lockedSource(record.handle.sourceRoot, effect)),
      );

    const createInternal = (
      input: CreateWorkspaceInput,
      source: SourceCheckout,
      predecessor?: WorkspaceRecord,
    ) =>
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
        };
        let record: WorkspaceRecord = {
          version: 1,
          handle,
          status: "creating",
          baseline: "",
          predecessorWorkspaceId: predecessor?.handle.workspaceId,
          ownerLease: yield* ownerPresence,
        };
        yield* Effect.gen(function* () {
          yield* workspaceIO("create", () => fs.mkdir(dir, { mode: 0o700 }));
          yield* syncWorkspaceDirectory(registry);
          yield* saveWorkspaceRecord(registry, record);
        }).pipe(Effect.uninterruptible);
        return yield* Effect.gen(function* () {
          yield* git(dir, ["init", "--bare", "--template=", "--object-format=sha1", "repo.git"]);
          yield* neutralizeAttributes(repository(record));
          let snapshotRoot = source.sourceRoot;
          if (predecessor) {
            snapshotRoot = path.join(dir, "seed");
            yield* git(repository(predecessor), [
              "worktree",
              "add",
              "--detach",
              snapshotRoot,
              predecessor.baseline,
            ]);
          }
          const identity = predecessor ? undefined : yield* sourceIdentity(source.sourceRoot);
          const baseline = yield* capture(record, snapshotRoot, "baseline", true);
          const verified = yield* capture(record, snapshotRoot, "verify-baseline", true);
          if (verified.tree !== baseline.tree)
            return yield* workspaceFailure("create", "Source changed during snapshot acquisition.");
          if (identity) {
            const current = yield* sourceIdentity(source.sourceRoot);
            if (current.head !== identity.head || current.index !== identity.index)
              return yield* workspaceFailure(
                "create",
                "Source branch or index changed during snapshot acquisition.",
              );
          }
          if (predecessor) {
            const originalTree = yield* treeOf(repository(predecessor), predecessor.baseline);
            if (originalTree !== baseline.tree)
              return yield* workspaceFailure(
                "fork",
                "Original baseline could not be reproduced exactly.",
              );
            yield* git(repository(predecessor), ["worktree", "remove", snapshotRoot]);
          }
          const omittedTrackedPaths = predecessor
            ? predecessor.handle.omittedTrackedPaths
            : baseline.omittedTrackedPaths;
          const acquired: WorkspaceHandle = {
            ...handle,
            ...(omittedTrackedPaths !== undefined &&
              omittedTrackedPaths.length > 0 && { omittedTrackedPaths }),
          };
          record = {
            ...record,
            handle: acquired,
            baseline: baseline.commit,
            excludedPaths: predecessor ? predecessor.excludedPaths : baseline.excludedPaths,
          };
          yield* saveWorkspaceRecord(registry, record);
          yield* git(repository(record), [
            "worktree",
            "add",
            "--detach",
            worker(record),
            baseline.commit,
          ]);
          yield* checkDirectory(acquired.cwd);
          const ready: WorkspaceHandle = {
            ...acquired,
            writerCwd: yield* canonicalizeWriterDirectory(acquired.cwd).pipe(
              Effect.mapError((error) => workspaceFailure("create", error.message)),
            ),
          };
          yield* saveWorkspaceRecord(
            registry,
            { ...record, handle: ready, status: "active" },
            () => {
              owned.add(workspaceId);
              input.onAcquired?.(ready);
            },
          );
          return ready;
        }).pipe(
          Effect.catchIf(
            (error) => !error.cleanupUnconfirmed && !predecessor,
            (error) =>
              workspaceIO("create-cleanup", () =>
                fs.rm(dir, { recursive: true, force: true }),
              ).pipe(Effect.andThen(Effect.fail(error))),
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
      const source = yield* inspectSource(input.sourceCwd);
      yield* initializeWorkspaceStore(registry);
      return yield* lockedSource(source.sourceRoot, createInternal(input, source));
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
      const snapshot = yield* capture(record, worker(record), "revision");
      const diff = yield* git(repository(record), [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        record.baseline,
        snapshot.commit,
        "--",
      ]);
      const changedPaths = yield* gitFields(repository(record), [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        record.baseline,
        snapshot.commit,
        "--",
      ]);
      const baselineLinks = (yield* gitFields(repository(record), [
        "ls-tree",
        "-r",
        "-z",
        record.baseline,
      ]))
        .filter((entry) => entry.startsWith("120000 "))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));
      const linkPaths = new Set([
        ...baselineLinks,
        ...snapshot.entries.filter((entry) => entry.mode === "120000").map((entry) => entry.path),
      ]);
      if (changedPaths.some((name) => linkPaths.has(name)))
        return yield* workspaceFailure(
          "freeze",
          "Creating, removing or changing symlinks is unsupported. Existing internal links must remain unchanged.",
        );
      const result = { revisionId: snapshot.commit, diff, changedPaths };
      yield* saveWorkspaceRecord(registry, { ...record, status: "frozen", revision: result });
      return result;
    }, locked);

    const prepare = Effect.fn("GitWorkspaceEngine.prepare")(function* (
      target: WorkspaceRevisionTarget,
    ) {
      const record = yield* checked(target);
      const reviewed = yield* revision(record, target.revisionId);
      if (record.status !== "frozen" && record.status !== "prepared")
        return yield* workspaceFailure("prepare", "Workspace is not awaiting integration.");
      const workerTree = yield* capture(record, worker(record), "verify-worker");
      const reviewedTree = yield* treeOf(repository(record), target.revisionId);
      if (workerTree.tree !== reviewedTree)
        return yield* workspaceFailure(
          "prepare",
          "Worker changed after review; freeze a new revision.",
        );
      const identity = yield* sourceIdentity(record.handle.sourceRoot);
      const parent = yield* capture(record, record.handle.sourceRoot, "parent", true);
      if (
        parent.entries.some(
          (entry) => entry.mode === "120000" && reviewed.changedPaths.includes(entry.path),
        )
      )
        return yield* workspaceFailure(
          "prepare",
          "A changed path is now a source symlink; integration refused.",
        );
      const preparationId = yield* newWorkspaceId;
      const preparedRoot = path.join(directory(record), `prepare-${preparationId}`);
      yield* git(repository(record), ["worktree", "add", "--detach", preparedRoot, parent.commit]);
      if (reviewed.diff.length > 0) {
        const stdin = new TextEncoder().encode(reviewed.diff);
        yield* git(preparedRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], {
          stdin,
        });
        yield* git(preparedRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { stdin });
      }
      const combined = yield* capture(record, preparedRoot, `prepared-${preparationId}`);
      const leaseDirectories = yield* requiredLeaseDirectories(record, reviewed.changedPaths);
      const result = {
        preparationId,
        revisionId: target.revisionId,
        cwd: path.join(preparedRoot, subdirectory(record)),
        leaseDirectories,
      };
      yield* checkDirectory(result.cwd);
      yield* saveWorkspaceRecord(registry, {
        ...record,
        status: "prepared",
        preparation: result,
        parentTree: parent.tree,
        preparedTree: combined.tree,
        sourceHead: identity.head,
        sourceIndex: identity.index,
      });
      return result;
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
      const reviewedTree = yield* treeOf(repository(record), target.revisionId);
      const workerTree = yield* capture(record, worker(record), "verify-worker");
      const preparedRoot = path.join(directory(record), `prepare-${target.preparationId}`);
      const prepared = yield* capture(record, preparedRoot, "verify-prepared");
      const before = yield* capture(record, record.handle.sourceRoot, "verify-parent", true);
      const identity = yield* sourceIdentity(record.handle.sourceRoot);
      if (
        workerTree.tree !== reviewedTree ||
        prepared.tree !== record.preparedTree ||
        before.tree !== record.parentTree ||
        identity.head !== record.sourceHead ||
        identity.index !== record.sourceIndex
      )
        return yield* workspaceFailure(
          "integrate",
          "Worker, test tree, source, branch or index changed; review and test again.",
        );
      const required = yield* requiredLeaseDirectories(record, reviewed.changedPaths);
      if (required.some((ancestor) => !preparation.leaseDirectories.includes(ancestor)))
        return yield* workspaceFailure(
          "integrate",
          "Changed-file ancestors changed; prepare and test again before integration.",
        );
      const publication = yield* publishWorkspace(registry, record, before, prepared, preparation);
      const after = yield* sourceIdentity(record.handle.sourceRoot);
      if (after.head !== identity.head || after.index !== identity.index)
        return yield* workspaceFailure(
          "integrate",
          "Concurrent source branch/index mutation detected; inspect the retained publication journal.",
        );
      const integrated: WorkspaceRecord = { ...publication.record, status: "integrated" };
      yield* saveWorkspaceRecord(registry, integrated);
      const remainingBackupPaths = yield* removePublicationBackups(publication.backups);
      const uncapturedPaths = workerTree.excludedPaths;
      const treeRemovalFailed = target.retainTrees
        ? false
        : yield* removeWorkspaceTrees(registry, integrated, uncapturedPaths.length > 0).pipe(
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
        uncapturedPaths,
        treeRemovalFailed,
        remainingBackupPaths,
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
        version: 1,
        handle: record.handle,
        baseline: record.baseline,
        predecessorWorkspaceId: record.predecessorWorkspaceId,
        ownerLease: record.ownerLease,
        excludedPaths: record.excludedPaths,
        status: "active",
      };
      yield* saveWorkspaceRecord(registry, next);
      return next.handle;
    }, locked);
    const fork = Effect.fn("GitWorkspaceEngine.fork")(function* (
      target: WorkspaceSettledTarget & { readonly onAcquired?: WorkspaceAcquired | undefined },
    ) {
      yield* settled(target);
      const record = yield* checked(target);
      if (!record.baseline || record.status === "discarded")
        return yield* workspaceFailure("fork", "Original baseline is unavailable.");
      return yield* createInternal(
        {
          sourceCwd: record.handle.sourceCwd,
          ownerId: record.handle.ownerId,
          onAcquired: target.onAcquired,
        },
        {
          sourceRoot: record.handle.sourceRoot,
          sourceCwd: record.handle.sourceCwd,
          subdirectory: subdirectory(record),
        },
        record,
      );
    }, locked);
    const discardInternal = (target: WorkspaceSettledTarget) =>
      Effect.gen(function* () {
        yield* settled(target);
        const record = yield* checked(target);
        if (record.status === "integrating")
          return yield* workspaceFailure(
            "discard",
            "Partial publication backups require manual recovery before discard.",
          );
        yield* removeWorkspaceTrees(registry, record);
        yield* saveWorkspaceRecord(registry, { ...record, status: "discarded" });
        owned.delete(target.workspaceId);
        return undefined;
      });
    const discard = (target: WorkspaceSettledTarget) => locked(discardInternal(target), target);
    // An orphan's creating session has ended (its owner lease is free); the caller separately
    // proves no writer still holds the worker tree.
    const discardOrphan = Effect.fn("GitWorkspaceEngine.discardOrphan")(function* (
      target: WorkspaceOrphanTarget,
    ) {
      if (owned.has(target.workspaceId))
        return yield* workspaceFailure(
          "authorization",
          "This session owns the workspace; discard it as its parent.",
        );
      const record = yield* managedRecord(target.workspaceId);
      if (record.ownerLease === undefined)
        return yield* workspaceFailure(
          "authorization",
          "The workspace has no owner evidence, so its session can't be shown to have ended.",
        );
      if (record.status === "integrating")
        return yield* workspaceFailure(
          "discard",
          "Partial publication backups require manual recovery before discard.",
        );
      const discarded = yield* withFreeLock(
        locks,
        lockDirectory,
        ownerNamespace(record.ownerLease),
        Effect.gen(function* () {
          yield* removeWorkspaceTrees(registry, record);
          yield* saveWorkspaceRecord(registry, { ...record, status: "discarded" });
        }),
      );
      if (Option.isNone(discarded))
        return yield* workspaceFailure(
          "authorization",
          "The session that created this workspace is still running.",
        );
      return undefined;
    }, locked);
    const collectGarbage = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* collectWorkspaceRecords(registry, {
        now,
        owned: (workspaceId) => owned.has(workspaceId),
        whenSourceFree: (sourceRoot, effect) =>
          withFreeLock(locks, lockDirectory, sourceLockNamespace(sourceRoot), effect),
      });
    });
    const setup = Effect.fn("GitWorkspaceEngine.setup")(function* (
      target: WorkspaceSetupTarget & { readonly setup: WorkspaceSetup },
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (
        preparation === undefined
          ? record.status !== "active"
          : record.status !== "prepared" || record.preparation?.preparationId !== preparation
      )
        return yield* workspaceFailure("setup", "The setup tree is stale or unavailable.");
      const root =
        preparation === undefined
          ? worker(record)
          : path.join(directory(record), `prepare-${preparation}`);
      // Persist before spawning. Interruption or a failed cleanup/record commit keeps this proof
      // missing across runtime replacement; neither caller cleanup nor orphan discard can erase it.
      yield* Effect.uninterruptibleMask((restore) =>
        saveWorkspaceRecord(registry, { ...record, setupCleanupPending: root }).pipe(
          Effect.andThen(
            restore(runWorkspaceSetup(target.setup, root)).pipe(
              Effect.matchEffect({
                onFailure: (error) => {
                  const failure = new WorkspaceError({
                    operation: "setup",
                    message: error.message,
                    cleanupUnconfirmed: error.cleanupUnconfirmed,
                  });
                  return error.cleanupUnconfirmed
                    ? Effect.fail(failure)
                    : saveWorkspaceRecord(registry, record).pipe(
                        Effect.andThen(Effect.fail(failure)),
                      );
                },
                onSuccess: () => saveWorkspaceRecord(registry, record),
              }),
            ),
          ),
        ),
      );
      return undefined;
    }, locked);
    // A setup command may only add ignored or excluded files such as dependencies; anything else
    // would enter the worker's proposal or invalidate the prepared tree.
    const setupChanges = Effect.fn("GitWorkspaceEngine.setupChanges")(function* (
      target: WorkspaceSetupTarget,
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (preparation === undefined) {
        if (record.status !== "active")
          return yield* workspaceFailure("setup", "Only a new active workspace may run setup.");
        const snapshot = yield* capture(record, worker(record), "setup-worker");
        return yield* gitFields(repository(record), [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          record.baseline,
          snapshot.commit,
          "--",
        ]);
      }
      if (
        record.status !== "prepared" ||
        record.preparation?.preparationId !== preparation ||
        record.preparedTree === undefined
      )
        return yield* workspaceFailure("setup", "Preparation is stale or unknown.");
      const prepared = path.join(directory(record), `prepare-${preparation}`);
      const snapshot = yield* capture(record, prepared, `setup-prepared-${preparation}`);
      if (snapshot.tree === record.preparedTree) return [];
      return yield* gitFields(repository(record), [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        record.preparedTree,
        snapshot.tree,
        "--",
      ]);
    }, locked);
    const inspect = (target: WorkspaceTarget) => checked(target, false);
    const listAll = listWorkspaceRecords(registry);
    const list = (input: { readonly ownerId: string }) =>
      listAll.pipe(
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
      fork,
      discard,
      discardOrphan,
      collectGarbage,
      setup,
      setupChanges,
      inspect,
      list,
      listAll,
    };
  });
