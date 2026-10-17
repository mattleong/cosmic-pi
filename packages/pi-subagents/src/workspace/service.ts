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
  WorkspaceHandle,
  WorkspaceIntegration,
  WorkspaceIntegrationTarget,
  WorkspaceListing,
  WorkspaceOrphanTarget,
  WorkspacePreparation,
  WorkspaceQuarantineObserver,
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceRevisionTarget,
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
  readonly prepare: (
    target: WorkspaceRevisionTarget,
  ) => Effect.Effect<WorkspacePreparation, WorkspaceError>;
  readonly integrate: (
    target: WorkspaceIntegrationTarget,
  ) => Effect.Effect<WorkspaceIntegration, WorkspaceError>;
  readonly revise: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly fork: (
    target: WorkspaceSettledTarget & { readonly onAcquired?: WorkspaceAcquired | undefined },
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly discard: (target: WorkspaceSettledTarget) => Effect.Effect<void, WorkspaceError>;
  /** Discards a workspace whose creating session provably ended; the caller proves its writer stopped. */
  readonly discardOrphan: (target: WorkspaceOrphanTarget) => Effect.Effect<void, WorkspaceError>;
  /**
   * Runs setup with durable process-cleanup quarantine, including across owner shutdown. A failure
   * without `cleanupUnconfirmed` leaves no quarantine; a failed or interrupted preparation setup
   * withdraws that preparation.
   */
  readonly setup: (
    target: WorkspaceSetupTarget & WorkspaceQuarantineObserver & { readonly setup: WorkspaceSetup },
  ) => Effect.Effect<void, WorkspaceError>;
  /**
   * Runs a verification command in a prepared tree under the same quarantine as setup, then
   * requires the tree unchanged apart from ignored or excluded files. Failure keeps the
   * preparation and carries the output tail in `detail`.
   */
  readonly verify: (
    target: WorkspaceVerifyTarget &
      WorkspaceQuarantineObserver & { readonly verify: WorkspaceTreeCommand },
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
  /** Workspaces created from this one's worker tree that are neither integrated nor discarded. */
  readonly unresolvedChildren: (
    target: WorkspaceOrphanTarget,
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
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
          fork: (input) => run(engine.fork(input)),
          discard: (input) => run(engine.discard(input)),
          discardOrphan: (input) => run(engine.discardOrphan(input)),
          // Setup and verify take the permit only around their record changes, never while their
          // command runs.
          setup: (input) => provided(engine.setup(input)),
          verify: (input) => provided(engine.verify(input)),
          setupChanges: (input) => run(engine.setupChanges(input)),
          inspectWorkerChanges: (input) => run(engine.inspectWorkerChanges(input)),
          inspect: (input) => run(engine.inspect(input)),
          // A lock-free listing: callers check it under the run lock, so it never waits behind
          // engine work, and this process's in-flight creates are tracked by their launches.
          unresolvedChildren: (input) => provided(engine.unresolvedChildren(input)),
          list: (input) => run(engine.list(input)),
          listAll: run(engine.listAll),
        });
      }),
    );
}
