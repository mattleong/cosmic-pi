import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { CrossProcessLock, nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import type { WorkspaceSetup } from "../config/schema.ts";
import { gitWorkspaceEngine, workspaceRegistry } from "../boundary/git-worktree.ts";
import { workspaceLockDirectory } from "../boundary/git-worktree-store.ts";
import type {
  WorkspaceAcquired,
  WorkspaceError,
  WorkspaceExport,
  WorkspaceExportTarget,
  WorkspaceHandle,
  WorkspaceIntegration,
  WorkspaceIntegrationTarget,
  WorkspaceListing,
  WorkspaceOrphanExportTarget,
  WorkspaceOrphanTarget,
  WorkspacePreparation,
  WorkspacePreparationTarget,
  WorkspaceRebase,
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceSettledTarget,
  WorkspaceSetupTarget,
  WorkspaceTarget,
  WorkspaceTreeCommand,
  WorkspaceVerification,
  WorkspaceVerifyTarget,
  WorkspaceWorkerChanges,
} from "./model.ts";

export interface WorkspaceServiceContract {
  /**
   * Snapshots `sourceCwd` into a new workspace. A source inside private workspace storage must be
   * `sourceWorkspace`'s live, active worker tree or a directory in it; the new workspace then
   * integrates into that tree, and the source's worker tree is kept until it is resolved.
   */
  readonly create: (input: {
    readonly sourceCwd: string;
    readonly ownerId: string;
    readonly sourceWorkspace?: WorkspaceTarget | undefined;
    readonly onAcquired?: WorkspaceAcquired | undefined;
  }) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly freeze: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceRevision, WorkspaceError>;
  /** Prepares the revision, or with `paths` only those of its changes. */
  readonly prepare: (
    target: WorkspacePreparationTarget,
  ) => Effect.Effect<WorkspacePreparation, WorkspaceError>;
  /**
   * Publishes the prepared changes. A partial preparation's integration leaves the workspace
   * active, proposing its remaining changes against an advanced baseline.
   */
  readonly integrate: (
    target: WorkspaceIntegrationTarget,
  ) => Effect.Effect<WorkspaceIntegration, WorkspaceError>;
  readonly revise: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  /**
   * Rebuilds the worker tree in place from a fresh snapshot of its source, reapplies its changes
   * with a three-way merge, and leaves the workspace active. Refuses, changing nothing, when the
   * merge can't run at all.
   */
  readonly rebase: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceRebase, WorkspaceError>;
  /** Writes the frozen revision as a patch file or branch in the source repository. */
  readonly exportRevision: (
    target: WorkspaceExportTarget,
  ) => Effect.Effect<WorkspaceExport, WorkspaceError>;
  /**
   * Exports a workspace whose creating session provably ended, without changing it; the caller
   * proves its writer stopped.
   */
  readonly exportOrphan: (
    target: WorkspaceOrphanExportTarget,
  ) => Effect.Effect<WorkspaceExport, WorkspaceError>;
  readonly discard: (target: WorkspaceSettledTarget) => Effect.Effect<void, WorkspaceError>;
  /** Discards a workspace whose creating session provably ended; the caller proves its writer stopped. */
  readonly discardOrphan: (target: WorkspaceOrphanTarget) => Effect.Effect<void, WorkspaceError>;
  /**
   * Runs setup with durable process-cleanup quarantine, including across owner shutdown. A failure
   * without `cleanupUnconfirmed` leaves no quarantine; a failed or interrupted preparation setup
   * withdraws that preparation. `commandCleanupPending` reports the quarantine.
   */
  readonly setup: (
    target: WorkspaceSetupTarget & { readonly setup: WorkspaceSetup },
  ) => Effect.Effect<void, WorkspaceError>;
  /**
   * Runs a verification command in a prepared tree under the same quarantine as setup, then
   * requires the tree unchanged apart from ignored or excluded files. Failure keeps the
   * preparation and carries the output tail in `detail`.
   */
  readonly verify: (
    target: WorkspaceVerifyTarget & { readonly verify: WorkspaceTreeCommand },
  ) => Effect.Effect<WorkspaceVerification, WorkspaceError>;
  /** Paths a setup command changed relative to the tree it ran in. */
  readonly setupChanges: (
    target: WorkspaceSetupTarget,
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
  /** Compares the worker tree with its baseline without freezing or saving anything. */
  readonly inspectWorkerChanges: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceWorkerChanges, WorkspaceError>;
  readonly inspect: (target: WorkspaceTarget) => Effect.Effect<WorkspaceRecord, WorkspaceError>;
  /** The record's current revision with its patch, or undefined while it holds none. */
  readonly revision: (
    target: WorkspaceTarget,
  ) => Effect.Effect<WorkspaceRevision | undefined, WorkspaceError>;
  /** Workspaces created from this one's worker tree that are neither integrated nor discarded. */
  readonly unresolvedChildren: (
    target: WorkspaceOrphanTarget,
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
  /**
   * Whether the durable setup/verification marker is set: a command is running in one of the
   * workspace's trees, or its process cleanup is unconfirmed.
   */
  readonly commandCleanupPending: (
    target: WorkspaceOrphanTarget,
  ) => Effect.Effect<boolean, WorkspaceError>;
  readonly list: (input: {
    readonly ownerId: string;
  }) => Effect.Effect<ReadonlyArray<WorkspaceRecord>, WorkspaceError>;
  readonly listAll: Effect.Effect<WorkspaceListing, WorkspaceError>;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceContract>()(
  "pi-subagents/workspace/service/WorkspaceService",
) {
  static readonly layer = (options: {
    readonly agentDirectory: string;
  }): Layer.Layer<WorkspaceService, WorkspaceError> =>
    Layer.unwrap(
      workspaceRegistry(options.agentDirectory).pipe(
        Effect.map((registry) =>
          WorkspaceService.layerAt(registry).pipe(
            Layer.provide(CrossProcessLock.layer({ directory: workspaceLockDirectory(registry) })),
          ),
        ),
      ),
    ).pipe(Layer.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer))));

  private static readonly layerAt = (registry: string) =>
    Layer.effect(
      WorkspaceService,
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        const engine = yield* gitWorkspaceEngine(registry, lock.withPermits(1));
        const safe = yield* SafeFile;
        const provided = <A, E>(effect: Effect.Effect<A, E, SafeFile>) =>
          effect.pipe(Effect.provideService(SafeFile, safe));
        const run = <A, E>(effect: Effect.Effect<A, E, SafeFile>) =>
          lock.withPermits(1)(provided(effect));
        // Collection holds the service's permit, so the first operation sees its result.
        yield* lock.take(1);
        yield* engine.collectGarbage.pipe(
          Effect.provideService(SafeFile, safe),
          Effect.catch((error) =>
            Effect.logWarning(`Workspace records were not collected: ${error.message}`),
          ),
          Effect.ensuring(lock.release(1)),
          Effect.forkScoped,
        );
        return WorkspaceService.of({
          create: (input) => run(engine.create(input)),
          freeze: (input) => run(engine.freeze(input)),
          prepare: (input) => run(engine.prepare(input)),
          integrate: (input) => run(engine.integrate(input)),
          revise: (input) => run(engine.revise(input)),
          rebase: (input) => run(engine.rebase(input)),
          exportRevision: (input) => run(engine.exportRevision(input)),
          exportOrphan: (input) => run(engine.exportOrphan(input)),
          discard: (input) => run(engine.discard(input)),
          discardOrphan: (input) => run(engine.discardOrphan(input)),
          // Setup and verify take the permit only around their record changes, never while their
          // command runs.
          setup: (input) => provided(engine.setup(input)),
          verify: (input) => provided(engine.verify(input)),
          setupChanges: (input) => run(engine.setupChanges(input)),
          inspectWorkerChanges: (input) => run(engine.inspectWorkerChanges(input)),
          inspect: (input) => run(engine.inspect(input)),
          revision: (input) => run(engine.revision(input)),
          // Lock-free reads: callers check them under the run lock, so they never wait behind
          // engine work, and this process's in-flight creates are tracked by their launches.
          unresolvedChildren: (input) => provided(engine.unresolvedChildren(input)),
          commandCleanupPending: (input) => provided(engine.commandCleanupPending(input)),
          list: (input) => run(engine.list(input)),
          listAll: run(engine.listAll),
        });
      }),
    );
}
