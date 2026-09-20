import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { makeGitWorkspaceEngine } from "../boundary/git-worktree.ts";
import type {
  WorkspaceError,
  WorkspaceHandle,
  WorkspaceIntegrationTarget,
  WorkspaceListing,
  WorkspacePreparation,
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceRevisionTarget,
  WorkspaceSettledTarget,
  WorkspaceTarget,
} from "./model.ts";

export interface WorkspaceServiceContract {
  readonly create: (input: {
    readonly sourceCwd: string;
    readonly ownerId: string;
  }) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly freeze: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceRevision, WorkspaceError>;
  readonly prepare: (
    target: WorkspaceRevisionTarget,
  ) => Effect.Effect<WorkspacePreparation, WorkspaceError>;
  readonly integrate: (
    target: WorkspaceIntegrationTarget,
  ) => Effect.Effect<WorkspaceRecord, WorkspaceError>;
  readonly revise: (
    target: WorkspaceSettledTarget & { readonly revisionId?: string },
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly fork: (target: WorkspaceSettledTarget) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly discard: (target: WorkspaceSettledTarget) => Effect.Effect<void, WorkspaceError>;
  readonly recoverDiscard: (
    target: WorkspaceSettledTarget & { readonly recoveryRiskAccepted: true },
  ) => Effect.Effect<void, WorkspaceError>;
  readonly inspect: (target: WorkspaceTarget) => Effect.Effect<WorkspaceRecord, WorkspaceError>;
  readonly list: (input: {
    readonly ownerId: string;
  }) => Effect.Effect<ReadonlyArray<WorkspaceRecord>, WorkspaceError>;
  readonly listAll: () => Effect.Effect<WorkspaceListing, WorkspaceError>;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceContract>()(
  "pi-subagents/workspace/service/WorkspaceService",
) {
  static readonly layer = (options: {
    readonly agentDirectory: string;
  }): Layer.Layer<WorkspaceService, WorkspaceError> =>
    Layer.effect(
      WorkspaceService,
      Effect.gen(function* () {
        const engine = yield* makeGitWorkspaceEngine(options.agentDirectory);
        const lock = yield* Semaphore.make(1);
        const safe = yield* SafeFile;
        const run = <A>(effect: Effect.Effect<A, WorkspaceError, SafeFile>) =>
          lock.withPermits(1)(effect.pipe(Effect.provideService(SafeFile, safe)));
        return WorkspaceService.of({
          create: (input) => run(engine.create(input)),
          freeze: (input) => run(engine.freeze(input)),
          prepare: (input) => run(engine.prepare(input)),
          integrate: (input) => run(engine.integrate(input)),
          revise: (input) => run(engine.revise(input)),
          fork: (input) => run(engine.fork(input)),
          discard: (input) => run(engine.discard(input)),
          recoverDiscard: (input) => run(engine.recoverDiscard(input)),
          inspect: (input) => run(engine.inspect(input)),
          list: (input) => run(engine.list(input)),
          listAll: () => run(engine.listAll()),
        });
      }),
    ).pipe(Layer.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer))));
}
