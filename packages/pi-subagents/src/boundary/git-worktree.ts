import * as Effect from "effect/Effect";
import type {
  WorkspaceAcquired,
  WorkspaceHandle,
  WorkspaceIntegrationTarget,
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
} from "./git-worktree-process.ts";
import { captureSnapshot, inspectSource, sourceIdentity } from "./git-worktree-snapshot.ts";
import {
  initializeWorkspaceStore,
  newWorkspaceId,
  readWorkspaceRecord,
  saveWorkspaceRecord,
  syncWorkspaceDirectory,
  validWorkspaceId,
  workspaceDirectory,
  withWorkspaceStoreLock,
} from "./git-worktree-store.ts";
import { listWorkspaceRecords, removeWorkspaceTrees } from "./git-worktree-recovery.ts";
import { publishWorkspace, requiredLeaseDirectories } from "./git-worktree-integration.ts";

const treeOf = (repository: string, revision: string) =>
  git(repository, ["rev-parse", `${revision}^{tree}`]).pipe(Effect.flatMap(oid));
const subdirectory = (record: WorkspaceRecord) =>
  path.relative(record.handle.sourceRoot, record.handle.sourceCwd);

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

export const makeGitWorkspaceEngine = (agentDirectory: string) =>
  Effect.sync(() => {
    const registry = path.resolve(agentDirectory, "git-workspaces");
    const owned = new Set<string>();
    const directory = (record: WorkspaceRecord) =>
      workspaceDirectory(registry, record.handle.workspaceId);
    const repository = (record: WorkspaceRecord) => path.join(directory(record), "repo.git");
    const worker = (record: WorkspaceRecord) => path.join(directory(record), "worker");
    const capture = (record: WorkspaceRecord, root: string, reference: string) =>
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
        return yield* captureSnapshot(
          root,
          repository(record),
          path.join(directory(record), "snapshot.index"),
          reference,
          requiredPaths,
        );
      });
    const checked = (target: WorkspaceTarget, requireLiveOwner = true) =>
      Effect.gen(function* () {
        const record = yield* readWorkspaceRecord(registry, target.workspaceId);
        if (
          record.handle.ownerId !== target.ownerId ||
          (requireLiveOwner && !owned.has(target.workspaceId))
        )
          return yield* workspaceFailure(
            "authorization",
            "Workspace is not owned by this parent and live session.",
          );
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
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withWorkspaceStoreLock(registry, effect);

    const createInternal = (input: CreateWorkspaceInput, predecessor?: WorkspaceRecord) =>
      Effect.gen(function* () {
        const source = predecessor
          ? {
              sourceRoot: predecessor.handle.sourceRoot,
              sourceCwd: predecessor.handle.sourceCwd,
              subdirectory: subdirectory(predecessor),
            }
          : yield* inspectSource(input.sourceCwd);
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
        };
        yield* Effect.gen(function* () {
          yield* workspaceIO("create", () => fs.mkdir(dir, { mode: 0o700 }));
          yield* syncWorkspaceDirectory(registry);
          yield* saveWorkspaceRecord(registry, record);
        }).pipe(Effect.uninterruptible);
        return yield* Effect.gen(function* () {
          yield* git(dir, ["init", "--bare", "--template=", "--object-format=sha1", "repo.git"]);
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
          const baseline = yield* capture(record, snapshotRoot, "baseline");
          const verified = yield* capture(record, snapshotRoot, "verify-baseline");
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
          record = {
            ...record,
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
          yield* checkDirectory(handle.cwd);
          yield* saveWorkspaceRecord(registry, { ...record, status: "active" }, () => {
            owned.add(workspaceId);
            input.onAcquired?.(handle);
          });
          return handle;
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
      yield* initializeWorkspaceStore(registry);
      return yield* locked(createInternal(input));
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
      const parent = yield* capture(record, record.handle.sourceRoot, "parent");
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
      const before = yield* capture(record, record.handle.sourceRoot, "verify-parent");
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
      const result = yield* publishWorkspace(registry, record, before, prepared, preparation);
      const after = yield* sourceIdentity(record.handle.sourceRoot);
      if (after.head !== identity.head || after.index !== identity.index)
        return yield* workspaceFailure(
          "integrate",
          "Concurrent source branch/index mutation detected; inspect the retained publication journal.",
        );
      const integrated: WorkspaceRecord = { ...result, status: "integrated" };
      yield* saveWorkspaceRecord(registry, integrated);
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
    const discard = (target: WorkspaceSettledTarget) => locked(discardInternal(target));
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
      setupChanges,
      inspect,
      list,
      listAll,
    };
  });
