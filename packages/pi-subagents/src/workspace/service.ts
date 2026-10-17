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
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceRevisionTarget,
  WorkspaceSettledTarget,
  WorkspaceSetupTarget,
  WorkspaceTarget,
} from "./model.ts";

export interface WorkspaceServiceContract {
  readonly create: (input: {
    readonly sourceCwd: string;
    readonly ownerId: string;
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
  /** Runs setup with durable process-cleanup quarantine, including across owner shutdown. */
  readonly setup: (
    target: WorkspaceSetupTarget & { readonly setup: WorkspaceSetup },
  ) => Effect.Effect<void, WorkspaceError>;
  /** Paths a setup command changed relative to the tree it ran in. */
  readonly setupChanges: (
    target: WorkspaceSetupTarget,
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
  readonly inspect: (target: WorkspaceTarget) => Effect.Effect<WorkspaceRecord, WorkspaceError>;
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
          // Setup takes the permit only around its record changes, never while its command runs.
          setup: (input) => provided(engine.setup(input)),
          setupChanges: (input) => run(engine.setupChanges(input)),
          inspect: (input) => run(engine.inspect(input)),
          list: (input) => run(engine.list(input)),
          listAll: run(engine.listAll),
        });
      }),
    );
}
