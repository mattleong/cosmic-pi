import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { CrossProcessLock, type CrossProcessLease } from "pi-cosmic-core";
import type { WorkspaceSetup } from "../config/schema.ts";
import type { WorkspaceDiffStatFile } from "../workspace/diffstat.ts";
import { WorkspaceError, workspaceCheckoutRoot } from "../workspace/model.ts";
import { partialSelection } from "../workspace/policy.ts";
import { canonicalizeWriterDirectory } from "./writer-lease.ts";
import {
  runWorkspaceSetup,
  runWorkspaceVerification,
  type WorkspaceCommandError,
} from "./workspace-setup.ts";
import type {
  WorkspaceAcquired,
  WorkspaceExportTarget,
  WorkspaceHandle,
  WorkspaceIntegrationTarget,
  WorkspaceOrphanExportTarget,
  WorkspaceOrphanTarget,
  WorkspacePreparationTarget,
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceRevisionMetadata,
  WorkspaceSettledTarget,
  WorkspaceSetupTarget,
  WorkspaceTarget,
  WorkspaceTreeCommand,
  WorkspaceVerifyTarget,
  WorkspaceWorkerChanges,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  applyConflict,
  checkDirectory,
  git,
  gitFailure,
  gitFields,
  gitResult,
  gitSucceeded,
  listedPaths,
  oid,
  workspaceFailure,
  workspaceIO,
  workspaceRefusal,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";
import { supportedGitInstallation } from "./git-installation.ts";
import {
  type CaptureOptions,
  decodeRevisionDiff,
  inspectSource,
  preserveIgnoreRules,
  type SnapshotEntry,
  storeSnapshot,
  type WorkspaceTreeRead,
  sourceIdentity,
} from "./git-worktree-snapshot.ts";
import {
  exportProposal,
  frozenProposal,
  nestedExportRefusal,
  workerProposal,
} from "./git-worktree-export.ts";
import { commitRevisionPatch, patchBytes, revisionPatchBytes } from "./git-worktree-patch.ts";
import { rebaseWorkspace } from "./git-worktree-rebase.ts";
import {
  captureTree,
  readTree,
  refuseUncaptured,
  removePreparation as removePreparationTree,
  sourceCapture,
  withOutcome,
  workspaceArtifact,
  workspaceRepository,
  workspaceSubdirectory,
  workspaceWorker,
} from "./git-worktree-trees.ts";
import {
  initializeWorkspaceStore,
  newWorkspaceId,
  readWorkspaceRecord,
  revisionDiffExists,
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
  MAX_WORKSPACE_NESTING,
  removeWorkspaceTrees,
  unresolvedChildWorkspaces,
} from "./git-worktree-recovery.ts";
import {
  commitPublication,
  finishPublication,
  publishedMidIntegration,
  publishWorkspace,
  removeEmptiedDirectories,
  removePublicationBackups,
  requiredLeaseDirectories,
  rollbackPublication,
  touchedParentDrift,
} from "./git-worktree-integration.ts";

const ownerNamespace = (token: string) => `workspace-owner:${token}`;

const treeOf = (repository: string, revision: string) =>
  git(repository, ["rev-parse", `${revision}^{tree}`]).pipe(Effect.flatMap(oid));

type TreeEntries = ReadonlyMap<string, Pick<SnapshotEntry, "mode" | "oid">>;

/** Every file a stored tree or commit holds, by path. */
const treeEntries = (repository: string, tree: string) =>
  gitFields(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]).pipe(
    Effect.map(
      (lines): TreeEntries =>
        new Map(
          lines.map((line) => {
            const tab = line.indexOf("\t");
            const [mode = "", , id = ""] = line.slice(0, tab).split(" ");
            return [line.slice(tab + 1), { mode, oid: id }] as const;
          }),
        ),
    ),
  );

/** One `git diff --numstat -z` line as a diffstat file, its change kind read from both trees. */
const numstatFile = (
  line: string,
  before: TreeEntries,
  after: ReadonlyMap<string, Pick<SnapshotEntry, "mode">>,
): WorkspaceDiffStatFile => {
  const [added = "", deleted = "", ...rest] = line.split("\t");
  const name = rest.join("\t");
  const old = before.get(name);
  const current = after.get(name);
  const binary = added === "-";
  return {
    path: name,
    change: old === undefined ? "added" : current === undefined ? "deleted" : "modified",
    binary,
    addedLines: binary ? 0 : Number(added),
    deletedLines: binary ? 0 : Number(deleted),
    ...(old &&
      current &&
      old.mode !== current.mode && { modeChange: { from: old.mode, to: current.mode } }),
  };
};

/** Paths whose content or mode differs between a stored tree's files and a tree just read. */
const changedFrom = (
  stored: TreeEntries,
  read: ReadonlyArray<Pick<SnapshotEntry, "path" | "mode" | "oid">>,
) => {
  const current = new Map(read.map((entry) => [entry.path, entry]));
  return [...new Set([...stored.keys(), ...current.keys()])]
    .filter((name) => {
      const before = stored.get(name),
        after = current.get(name);
      return before?.oid !== after?.oid || before?.mode !== after?.mode;
    })
    .toSorted();
};
const subdirectory = workspaceSubdirectory;

interface SourceCheckout {
  readonly sourceRoot: string;
  readonly sourceCwd: string;
  readonly subdirectory: string;
  /** Set when the source is another workspace's worker tree (see WorkspaceHandle). */
  readonly sourceWorkspaceId?: string | undefined;
  readonly checkoutRoot?: string | undefined;
}

interface CreateWorkspaceInput {
  readonly sourceCwd: string;
  readonly ownerId: string;
  readonly sourceWorkspace?: WorkspaceTarget | undefined;
  readonly onAcquired?: WorkspaceAcquired | undefined;
}

const withinTree = (tree: string, target: string) =>
  target === tree || target.startsWith(`${tree}${path.sep}`);

const nestedSourceRefusal = (sourceCwd: string) =>
  workspaceRefusal("create", "The session directory isn't the source workspace's worker tree.", {
    path: sourceCwd,
    rule: "a nested workspace's source must be its named source workspace's worker tree or a directory inside it, never a prepared tree, private repository, or another workspace",
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

const withoutSetupMarker = ({ setupCleanupPending: _pending, ...record }: WorkspaceRecord) =>
  record;

// A failed preparation setup leaves the reviewed revision frozen, with nothing to integrate.
const withoutPreparation = ({
  preparation: _preparation,
  parentTree: _parentTree,
  preparedTree: _preparedTree,
  sourceHead: _sourceHead,
  sourceIndex: _sourceIndex,
  ...record
}: WorkspaceRecord): WorkspaceRecord => ({ ...record, status: "frozen" });

type TreeCommandOperation = "setup" | "verify";
const commandLabel = { setup: "setup", verify: "verification" } as const;
const MAX_LISTED_CHANGES = 5;

const listedChanges = (paths: ReadonlyArray<string>) =>
  `${paths.slice(0, MAX_LISTED_CHANGES).join(", ")}${
    paths.length > MAX_LISTED_CHANGES ? `, and ${paths.length - MAX_LISTED_CHANGES} more` : ""
  }`;

const commandFailure = (operation: TreeCommandOperation, error: WorkspaceCommandError) =>
  new WorkspaceError({
    operation,
    message: error.message,
    ...(operation === "verify" && error.outputTail && { detail: error.outputTail }),
    ...(error.cleanupUnconfirmed && { cleanupUnconfirmed: true }),
  });

/** Serializes this process's workspace operations; setup and verify release it while their command runs. */
export type WorkspaceOperationGate = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

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

/**
 * The engine for `registry` (see workspaceRegistry); CrossProcessLock must use its lock directory.
 * The caller serializes every operation with `gate` except setup, which takes it for each phase.
 */
export const gitWorkspaceEngine = (registry: string, gate: WorkspaceOperationGate) =>
  Effect.gen(function* () {
    const lockDirectory = workspaceLockDirectory(registry);
    const locks = yield* CrossProcessLock;
    const owned = new Set<string>();
    // Workspaces whose setup command this engine is running outside the locks.
    const settingUp = new Set<string>();
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
    const directory = (record: WorkspaceRecord) => workspaceArtifact(registry, record);
    const repository = (record: WorkspaceRecord) => workspaceRepository(registry, record);
    const worker = (record: WorkspaceRecord) => workspaceWorker(registry, record);
    const capture = (
      record: WorkspaceRecord,
      root: string,
      reference: string,
      options: Omit<CaptureOptions, "requiredPaths"> = {},
    ) => captureTree(registry, record, root, reference, options);
    const read = (
      record: WorkspaceRecord,
      root: string,
      options: Omit<CaptureOptions, "requiredPaths"> = {},
    ) => readTree(registry, record, root, options);
    const managedRecord = (workspaceId: string) =>
      Effect.gen(function* () {
        const record = yield* readWorkspaceRecord(registry, workspaceId);
        if (record.setupCleanupPending !== undefined && settingUp.has(workspaceId))
          return yield* new WorkspaceError({
            operation: "setup",
            message: "Workspace setup or verification is still running.",
            detail: `Command tree: ${record.setupCleanupPending}\nTry again once the command finishes.`,
            cleanupUnconfirmed: true,
          });
        if (record.setupCleanupPending !== undefined)
          return yield* new WorkspaceError({
            operation: "setup",
            message:
              "Workspace setup or verification cleanup is unconfirmed; the artifact is quarantined.",
            detail: `Command tree: ${record.setupCleanupPending}\nIndependently confirm the command's process and every descendant have stopped. Preserve the proposal and recovery record before manually recovering the private trees; restarting Pi does not clear this quarantine.`,
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
    const removePreparation = (record: WorkspaceRecord, preparationId: string) =>
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
    // hold unfinished work and must not be running a setup or verification command.
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
          cwd: path.join(dir, "worker", source.subdirectory),
          ...(source.sourceWorkspaceId !== undefined && {
            sourceWorkspaceId: source.sourceWorkspaceId,
            checkoutRoot: source.checkoutRoot,
          }),
        };
        let record: WorkspaceRecord = {
          version: 1,
          handle,
          status: "creating",
          baseline: "",
          ownerLease: yield* ownerPresence,
        };
        yield* Effect.gen(function* () {
          yield* workspaceIO("create", () => fs.mkdir(dir, { mode: 0o700 }));
          yield* syncWorkspaceDirectory(registry);
          yield* saveWorkspaceRecord(registry, record);
        }).pipe(Effect.uninterruptible);
        // A create that fails or is interrupted before it is acquired removes what it made, unless
        // a Git process's cleanup is uncertain.
        let handedOver = false;
        const removeCreated = workspaceIO("create-cleanup", () =>
          fs.rm(dir, { recursive: true, force: true }),
        ).pipe(Effect.uninterruptible);
        return yield* Effect.gen(function* () {
          yield* git(dir, ["init", "--bare", "--template=", "--object-format=sha1", "repo.git"]);
          yield* neutralizeAttributes(repository(record));
          // A source worker tree reads the rules its private repository recorded.
          yield* preserveIgnoreRules(repository(record), source.sourceRoot, {
            privateOrigin: source.sourceWorkspaceId !== undefined,
          });
          const identity = yield* sourceIdentity(source.sourceRoot);
          const baseline = yield* capture(
            record,
            source.sourceRoot,
            "baseline",
            sourceCapture(record),
          );
          const within = `${source.subdirectory}${path.sep}`;
          if (
            source.subdirectory !== "" &&
            !baseline.entries.some((entry) => entry.path.startsWith(within))
          )
            return yield* workspaceRefusal(
              "create",
              "The session directory has no files a workspace can capture.",
              {
                path: source.subdirectory,
                rule: "the session directory must hold a captured source file; empty, ignored and dependency or build directories (node_modules, vendor, dist, build, coverage, .pi) are never copied",
                remedy:
                  "Start Pi in a directory with tracked or source files, such as the repository root, or use the shared-checkout writer mode.",
              },
            );
          const verified = yield* read(record, source.sourceRoot, sourceCapture(record));
          if (verified.tree !== baseline.tree)
            return yield* workspaceFailure("create", "Source changed during snapshot acquisition.");
          const current = yield* sourceIdentity(source.sourceRoot);
          if (current.head !== identity.head || current.index !== identity.index)
            return yield* workspaceFailure(
              "create",
              "Source branch or index changed during snapshot acquisition.",
            );
          const { omittedTrackedPaths } = baseline;
          const acquired: WorkspaceHandle = {
            ...handle,
            ...(omittedTrackedPaths.length > 0 && { omittedTrackedPaths }),
          };
          record = {
            ...record,
            handle: acquired,
            baseline: baseline.commit,
            excludedPaths: baseline.excludedPaths,
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
      // The checked file becomes the revision's patch, kept beside the record and decoded strictly.
      const { diff } = yield* commitRevisionPatch(
        registry,
        record,
        snapshot.commit,
        changedPaths,
        "freeze",
      );
      const frozen = {
        revisionId: snapshot.commit,
        changedPaths,
        ...(snapshot.excludedPaths.length > 0 && { uncapturedPaths: snapshot.excludedPaths }),
      };
      const { rebasedTree: _rebasedTree, ...unprovisioned } = record;
      yield* saveWorkspaceRecord(registry, {
        ...unprovisioned,
        status: "frozen",
        revision: frozen,
      });
      return { ...frozen, diff } satisfies WorkspaceRevision;
    }, locked);
    // The record's revision with its patch, read back strictly like freeze wrote it. A patch an
    // earlier version kept inline is regenerated, which needs the store lock.
    const revisionWithDiff = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const frozen = record.revision;
        if (frozen === undefined) return undefined;
        const bytes = yield* revisionPatchBytes(registry, record, frozen);
        const diff = yield* decodeRevisionDiff(bytes, frozen.changedPaths);
        return { ...frozen, diff } satisfies WorkspaceRevision;
      });

    // The baseline with `paths` taken from the revision, committed through a temporary index in
    // the private repository: once a partial integration publishes them, they are no longer
    // changes, and the next freeze proposes only the rest.
    const advancedBaseline = (
      record: WorkspaceRecord,
      revisionId: string,
      paths: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const entries = yield* treeEntries(repository(record), revisionId);
        const index = path.join(directory(record), `${yield* newWorkspaceId}.index`);
        const environment = { GIT_INDEX_FILE: index };
        // `--index-info` removes a path given mode 0.
        const updates = paths.map((name) => {
          const entry = entries.get(name);
          return entry ? `${entry.mode} ${entry.oid}\t${name}\0` : `0 ${"0".repeat(40)}\t${name}\0`;
        });
        return yield* Effect.gen(function* () {
          yield* git(repository(record), ["read-tree", record.baseline], { environment });
          yield* git(repository(record), ["update-index", "-z", "--index-info"], {
            stdin: new TextEncoder().encode(updates.join("")),
            environment,
          });
          const tree = yield* git(repository(record), ["write-tree"], { environment }).pipe(
            Effect.flatMap(oid),
          );
          return yield* git(repository(record), ["commit-tree", tree, "-m", "baseline"]).pipe(
            Effect.flatMap(oid),
          );
        }).pipe(
          Effect.ensuring(
            workspaceIO("integrate", () => fs.rm(index, { force: true })).pipe(Effect.ignore),
          ),
        );
      });
    const prepare = Effect.fn("GitWorkspaceEngine.prepare")(function* (
      target: WorkspacePreparationTarget,
    ) {
      const record = yield* checked(target);
      const reviewed = yield* revision(record, target.revisionId);
      if (record.status !== "frozen" && record.status !== "prepared")
        return yield* workspaceFailure("prepare", "Workspace is not awaiting integration.");
      const paths = yield* preparationPaths(reviewed, target.paths);
      const selected = paths ?? reviewed.changedPaths;
      yield* refuseUncaptured("prepare", reviewed);
      yield* openSourceWorkspace(record, "prepare");
      const workerTree = yield* read(record, worker(record));
      const reviewedTree = yield* treeOf(repository(record), target.revisionId);
      if (workerTree.tree !== reviewedTree)
        return yield* workspaceFailure(
          "prepare",
          "Worker changed after review; freeze a new revision.",
        );
      const identity = yield* sourceIdentity(record.handle.sourceRoot);
      const parent = yield* capture(
        record,
        record.handle.sourceRoot,
        "parent",
        sourceCapture(record),
      );
      if (parent.entries.some((entry) => entry.mode === "120000" && selected.includes(entry.path)))
        return yield* workspaceFailure(
          "prepare",
          "A changed path is now a source symlink; integration refused.",
        );
      const preparationId = yield* newWorkspaceId;
      const preparedRoot = path.join(directory(record), `prepare-${preparationId}`);
      yield* git(repository(record), ["worktree", "add", "--detach", preparedRoot, parent.commit]);
      // A failed preparation never becomes integrable, so its copy of the source goes too; a
      // Git process whose cleanup is uncertain keeps the tree for manual recovery.
      let committed = false;
      return yield* Effect.gen(function* () {
        // A partial preparation applies only its paths' sections of the revision's patch.
        const stdin =
          paths === undefined
            ? new TextEncoder().encode((yield* revisionWithDiff(record))?.diff ?? "")
            : yield* patchBytes(
                registry,
                record,
                { from: record.baseline, to: target.revisionId },
                "prepare",
                paths,
              );
        if (stdin.length > 0) {
          const checkArgs = ["apply", "--check", "--binary", "--whitespace=nowarn", "-"];
          const check = yield* gitResult(preparedRoot, checkArgs, { stdin });
          if (!gitSucceeded(check))
            return yield* check.code !== null && !check.cleanupUnconfirmed
              ? applyConflict(check, selected)
              : gitFailure(checkArgs, check);
          yield* git(preparedRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { stdin });
        }
        const combined = yield* capture(record, preparedRoot, `prepared-${preparationId}`);
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
            preparedTree: combined.tree,
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
          (error) =>
            removePreparation(record, preparationId).pipe(Effect.andThen(Effect.fail(error))),
        ),
        Effect.onInterrupt(() =>
          committed ? Effect.void : removePreparation(record, preparationId),
        ),
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
      yield* refuseUncaptured("integrate", reviewed);
      yield* openSourceWorkspace(record, "integrate");
      const reviewedTree = yield* treeOf(repository(record), target.revisionId);
      const workerTree = yield* read(record, worker(record));
      const preparedRoot = path.join(directory(record), `prepare-${target.preparationId}`);
      const prepared = yield* read(record, preparedRoot);
      const before = yield* read(record, record.handle.sourceRoot, sourceCapture(record));
      const identity = yield* sourceIdentity(record.handle.sourceRoot);
      if (
        workerTree.tree !== reviewedTree ||
        prepared.tree !== record.preparedTree ||
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
          : changedFrom(yield* treeEntries(repository(record), record.parentTree), before.entries);
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
      // Read before publication, so a failure can't follow the commit. No child can appear
      // meanwhile: its creation takes this chain's lock.
      const partialBaseline =
        preparation.paths === undefined
          ? undefined
          : yield* advancedBaseline(record, target.revisionId, selected);
      const retainedForChildren =
        target.retainTrees || partialBaseline !== undefined
          ? []
          : yield* unresolvedChildWorkspaces(registry, target.workspaceId);
      const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
      const next = new Map(prepared.entries.map((entry) => [entry.path, entry]));
      // Only the proposal's own changes are published, so untouched parent edits stay.
      const changed = selected.filter((name) => {
        const current = previous.get(name),
          published = next.get(name);
        return current?.oid !== published?.oid || current?.mode !== published?.mode;
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
        version: 1,
        handle: record.handle,
        baseline: record.baseline,
        ownerLease: record.ownerLease,
        excludedPaths: record.excludedPaths,
        status: "active",
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
      // Rolling back needs the integrating session's source leases, which only it held.
      if (record.status === "integrating")
        return yield* workspaceRefusal(
          "discard",
          "The workspace was left mid-integration by a session that has ended.",
          {
            path: path.join(directory(record), "record.json"),
            rule: "only the session that started an integration can roll it back, because it holds the parent checkout's writer leases",
            remedy:
              "Compare the journal's paths with the parent checkout, restore each file from its backup (paths relative to the source root) or keep the published content, delete the backup and temporary files, then remove the private workspace directory.",
          },
        );
      yield* refuseWithChildren(record);
      const discarded = yield* withFreeLock(
        locks,
        lockDirectory,
        ownerNamespace(record.ownerLease),
        Effect.gen(function* () {
          yield* removeWorkspaceTrees(registry, record, { requireOriginalWorker: true });
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
    const exportRevision = Effect.fn("GitWorkspaceEngine.exportRevision")(function* (
      target: WorkspaceExportTarget,
    ) {
      const record = yield* checked(target);
      if (record.handle.sourceWorkspaceId !== undefined) return yield* nestedExportRefusal(record);
      return yield* exportProposal(
        registry,
        record,
        yield* frozenProposal(registry, record, target.revisionId),
        target.export,
      );
    }, locked);
    // Reads an orphan without changing its record or trees: an unfrozen worker tree is captured
    // into the private repository only, under its own reference.
    const exportOrphan = Effect.fn("GitWorkspaceEngine.exportOrphan")(function* (
      target: WorkspaceOrphanExportTarget,
    ) {
      if (owned.has(target.workspaceId))
        return yield* workspaceFailure(
          "authorization",
          "This session owns the workspace; export it as its parent.",
        );
      const record = yield* managedRecord(target.workspaceId);
      if (record.ownerLease === undefined)
        return yield* workspaceFailure(
          "authorization",
          "The workspace has no owner evidence, so its session can't be shown to have ended.",
        );
      if (record.handle.sourceWorkspaceId !== undefined) return yield* nestedExportRefusal(record);
      if (!["active", "frozen", "prepared"].includes(record.status))
        return yield* workspaceRefusal("export", "Only an unresolved proposal can be exported.", {
          path: path.join(directory(record), "record.json"),
          rule: `export reads an active, frozen, or prepared workspace, and this one is ${record.status}`,
          remedy:
            record.status === "integrating"
              ? "Recover the stopped integration manually from its journal."
              : "Nothing remains to export.",
        });
      const exported = yield* withFreeLock(
        locks,
        lockDirectory,
        ownerNamespace(record.ownerLease),
        Effect.gen(function* () {
          if (record.status !== "active")
            return yield* exportProposal(
              registry,
              record,
              yield* frozenProposal(registry, record, target.revisionId),
              target.export,
            );
          if (target.revisionId !== undefined)
            return yield* workspaceFailure(
              "revision",
              "The workspace holds no frozen revision; export it without revisionId.",
            );
          return yield* exportProposal(
            registry,
            record,
            yield* workerProposal(registry, record),
            target.export,
          );
        }),
      );
      if (Option.isNone(exported))
        return yield* workspaceFailure(
          "authorization",
          "The session that created this workspace is still running.",
        );
      return exported.value;
    }, locked);
    const rebase = Effect.fn("GitWorkspaceEngine.rebase")(function* (
      target: WorkspaceSettledTarget,
    ) {
      yield* settled(target);
      return yield* rebaseWorkspace(registry, yield* checked(target), managedRecord);
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
    const setupTree = (record: WorkspaceRecord, preparation: string | undefined) =>
      preparation === undefined
        ? worker(record)
        : path.join(directory(record), `prepare-${preparation}`);
    // Persist before spawning. Uncertain cleanup or a failed record commit keeps this proof missing
    // across runtime replacement; neither caller cleanup nor orphan discard can erase it, and every
    // other operation refuses the record while it is set.
    const beginSetup = Effect.fn("GitWorkspaceEngine.beginSetup")(function* (
      target: WorkspaceSetupTarget,
      operation: TreeCommandOperation,
      began: (root: string) => void,
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (
        preparation === undefined
          ? record.status !== "active"
          : record.status !== "prepared" || record.preparation?.preparationId !== preparation
      )
        return yield* workspaceFailure(
          operation,
          `The ${commandLabel[operation]} tree is stale or unavailable.`,
        );
      const root = setupTree(record, preparation);
      // A failed save may still have renamed the marker into place.
      yield* saveWorkspaceRecord(registry, { ...record, setupCleanupPending: root }, () =>
        began(root),
      ).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceError({
              operation,
              message: `Workspace ${commandLabel[operation]} couldn't record its quarantine marker; the artifact may stay quarantined.`,
              detail: [error.message, error.detail, `Command tree: ${root}`]
                .filter((line) => line !== undefined)
                .join("\n"),
              cleanupUnconfirmed: true,
            }),
        ),
      );
      return root;
    }, locked);
    // Clears the marker only after confirmed process cleanup, optionally withdrawing the
    // preparation so its untested tree can never be integrated.
    const finishSetup = Effect.fn("GitWorkspaceEngine.finishSetup")(function* (
      target: WorkspaceSetupTarget,
      root: string,
      withdraw: boolean,
    ) {
      const record = yield* readWorkspaceRecord(registry, target.workspaceId);
      if (record.setupCleanupPending !== root || record.handle.ownerId !== target.ownerId)
        return yield* workspaceFailure("setup", "The command quarantine record changed.");
      const cleared = withoutSetupMarker(record);
      const preparation = target.preparationId;
      if (!withdraw || preparation === undefined)
        return yield* saveWorkspaceRecord(registry, cleared);
      yield* saveWorkspaceRecord(registry, withoutPreparation(cleared));
      yield* removePreparation(cleared, preparation);
      return undefined;
    }, locked);
    // The command can run for up to an hour, so it holds neither this process's operation gate nor
    // the checkout's store lock; the durable marker keeps every other operation away. Once the
    // runner confirms the process group stopped, including after interruption, the marker is
    // cleared uninterruptibly before the outcome propagates; otherwise the artifact stays
    // quarantined.
    const runMarked = <A>(
      target: WorkspaceSetupTarget,
      operation: TreeCommandOperation,
      withdrawOnFailure: boolean,
      command: (
        root: string,
        onCleanup: (confirmed: boolean) => void,
      ) => Effect.Effect<A, WorkspaceError>,
    ) => {
      let marked: string | undefined;
      // Reported by the runner once it stops the command; absent when no process was spawned.
      let cleanupConfirmed: boolean | undefined;
      const label = commandLabel[operation];
      const finish = (root: string, failed: boolean, failure: WorkspaceError | undefined) =>
        gate(finishSetup(target, root, failed && withdrawOnFailure)).pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceError({
                operation,
                message: `Workspace ${label} stopped, but its quarantine couldn't be cleared; the artifact stays quarantined.`,
                detail: [failure?.message, error.message, error.detail, `Command tree: ${root}`]
                  .filter((line) => line !== undefined)
                  .join("\n"),
                cleanupUnconfirmed: true,
              }),
          ),
        );
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* restore(
            gate(
              beginSetup(target, operation, (root) => {
                marked = root;
                settingUp.add(target.workspaceId);
              }),
            ).pipe(
              Effect.flatMap((root) =>
                command(root, (confirmed) => {
                  cleanupConfirmed = confirmed;
                }),
              ),
            ),
          ).pipe(Effect.exit);
          const root = marked;
          // Refused before marking the tree, so no command ran.
          if (root === undefined) return yield* exit;
          if (Exit.isSuccess(exit)) {
            yield* finish(root, false, undefined);
            return exit.value;
          }
          if (Cause.hasInterrupts(exit.cause)) {
            if (cleanupConfirmed !== false)
              yield* finish(root, true, undefined).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`Interrupted workspace ${label}: ${error.message}`).pipe(
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
        Effect.withSpan(`GitWorkspaceEngine.${operation}`),
      );
    };
    // A failed or interrupted preparation setup withdraws the preparation.
    const setup = (target: WorkspaceSetupTarget & { readonly setup: WorkspaceSetup }) =>
      runMarked(target, "setup", true, (root, onCleanup) =>
        runWorkspaceSetup(target.setup, root, { onCleanup }).pipe(
          Effect.mapError((error) => commandFailure("setup", error)),
        ),
      );
    // A setup command may only add ignored or excluded files such as dependencies; anything else
    // would enter the worker's proposal or invalidate the prepared tree.
    // Compares the worker tree with its baseline in-process, storing nothing.
    const workerChanges = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const snapshot = yield* read(record, worker(record));
        const changedPaths =
          snapshot.tree === (yield* treeOf(repository(record), record.baseline))
            ? []
            : changedFrom(
                yield* treeEntries(repository(record), record.baseline),
                snapshot.entries,
              );
        return { snapshot, changedPaths };
      });
    // Git counts lines only between stored trees, so a changed worker tree is stored under its
    // own reference; freeze later stores its revision separately.
    const workerDiffStat = (record: WorkspaceRecord, snapshot: WorkspaceTreeRead) =>
      Effect.gen(function* () {
        const stored = yield* storeSnapshot(snapshot, repository(record), "inspection");
        const before = yield* treeEntries(repository(record), record.baseline);
        const after = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
        const lines = yield* gitFields(repository(record), [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          record.baseline,
          stored.commit,
          "--",
        ]);
        return lines.map((line) => numstatFile(line, before, after));
      });
    const setupChanges = Effect.fn("GitWorkspaceEngine.setupChanges")(function* (
      target: WorkspaceSetupTarget,
    ) {
      const record = yield* checked(target);
      const preparation = target.preparationId;
      if (preparation === undefined) {
        if (record.status !== "active")
          return yield* workspaceFailure("setup", "Only a new active workspace may run setup.");
        if (record.rebasedTree === undefined) return (yield* workerChanges(record)).changedPaths;
        // A rebuilt worker already differs from its baseline by the reapplied changes.
        const snapshot = yield* read(record, worker(record));
        if (snapshot.tree === record.rebasedTree) return [];
        return changedFrom(
          yield* treeEntries(repository(record), record.rebasedTree),
          snapshot.entries,
        );
      }
      if (
        record.status !== "prepared" ||
        record.preparation?.preparationId !== preparation ||
        record.preparedTree === undefined
      )
        return yield* workspaceFailure("setup", "Preparation is stale or unknown.");
      const prepared = path.join(directory(record), `prepare-${preparation}`);
      const snapshot = yield* read(record, prepared);
      if (snapshot.tree === record.preparedTree) return [];
      return changedFrom(
        yield* treeEntries(repository(record), record.preparedTree),
        snapshot.entries,
      );
    }, locked);
    // Verification may only add ignored or excluded files; a failure keeps the preparation so the
    // parent can inspect the tree. The coordinator never integrates a preparation that failed.
    const verify = (target: WorkspaceVerifyTarget & { readonly verify: WorkspaceTreeCommand }) =>
      Effect.gen(function* () {
        const result = yield* runMarked(target, "verify", false, (root, onCleanup) =>
          runWorkspaceVerification(target.verify, root, { onCleanup }).pipe(
            Effect.mapError((error) => commandFailure("verify", error)),
          ),
        );
        const changed = yield* gate(setupChanges(target));
        if (changed.length > 0)
          return yield* new WorkspaceError({
            operation: "verify",
            message: `Workspace verification changed project files (${listedChanges(changed)}); add its outputs to .gitignore.`,
            ...(result.outputTail && { detail: result.outputTail }),
          });
        return result;
      });
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
        uncapturedPaths: snapshot.excludedPaths,
        diffStat: changedPaths.length === 0 ? [] : yield* workerDiffStat(record, snapshot),
      } satisfies WorkspaceWorkerChanges;
    }, locked);
    const inspect = (target: WorkspaceTarget) => checked(target, false);
    // Reading takes no lock, unless a record frozen by an earlier version needs its patch written.
    const currentRevision = (target: WorkspaceTarget) =>
      Effect.gen(function* () {
        const record = yield* checked(target, false);
        if (
          record.revision === undefined ||
          (yield* revisionDiffExists(registry, target.workspaceId))
        )
          return yield* revisionWithDiff(record);
        return yield* locked(checked(target, false).pipe(Effect.flatMap(revisionWithDiff)), target);
      });
    const unresolvedChildren = (target: WorkspaceOrphanTarget) =>
      unresolvedChildWorkspaces(registry, target.workspaceId);
    const commandCleanupPending = (target: WorkspaceOrphanTarget) =>
      readWorkspaceRecord(registry, target.workspaceId).pipe(
        Effect.map((record) => record.setupCleanupPending !== undefined),
      );
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
      rebase,
      exportRevision,
      exportOrphan,
      discard,
      discardOrphan,
      collectGarbage,
      setup,
      verify,
      setupChanges,
      inspectWorkerChanges,
      inspect,
      revision: currentRevision,
      unresolvedChildren,
      commandCleanupPending,
      list,
      listAll,
    };
  });
