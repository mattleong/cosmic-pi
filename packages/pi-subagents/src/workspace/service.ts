import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { CrossProcessLock, nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import type { WorktreeHook } from "../config/schema.ts";
import { gitWorkspaceEngine, workspaceRegistry } from "../boundary/git-worktree.ts";
import { workspaceLockDirectory } from "../boundary/git-worktree-store.ts";
import type {
  WorkspaceAcquired,
  WorkspaceAdoptTarget,
  WorkspaceError,
  WorkspaceHandle,
  WorkspaceIntegration,
  WorkspaceIntegrationTarget,
  WorkspaceLaunch,
  WorkspaceListing,
  WorkspaceOrphanTarget,
  WorkspacePreparation,
  WorkspacePreparationTarget,
  WorkspaceRebase,
  WorkspaceRecord,
  WorkspaceRevision,
  WorkspaceHookTarget,
  WorkspaceSettledTarget,
  WorkspaceSweepTarget,
  WorkspaceSwept,
  WorkspaceTarget,
  WorkspaceWorkerChanges,
} from "./model.ts";

export interface WorkspaceServiceContract {
  /**
   * Snapshots `sourceCwd`, which must be outside private workspace storage, into a new workspace.
   * Untracked files the source's top-level `.worktreeinclude` matches and the baseline doesn't
   * carry are copied into the worker tree and every test tree, never into revisions.
   */
  readonly create: (input: {
    readonly sourceCwd: string;
    readonly ownerId: string;
    /** Recorded so a session that adopts the workspace can revise it with the same launch. */
    readonly launch?: WorkspaceLaunch | undefined;
    readonly onAcquired?: WorkspaceAcquired | undefined;
  }) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  readonly freeze: (
    target: WorkspaceSettledTarget,
  ) => Effect.Effect<WorkspaceRevision, WorkspaceError>;
  readonly prepare: (
    target: WorkspacePreparationTarget,
  ) => Effect.Effect<WorkspacePreparation, WorkspaceError>;
  /**
   * Writes the prepared changes into the parent checkout's files through a scratch index. A write
   * that stops partway leaves the record `integrating` until discard rolls it back.
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
  readonly discard: (target: WorkspaceSettledTarget) => Effect.Effect<void, WorkspaceError>;
  /**
   * Discards a workspace whose creating session provably ended; the caller proves its writer
   * stopped. A mid-integration orphan is rolled back first.
   */
  readonly discardOrphan: (target: WorkspaceOrphanTarget) => Effect.Effect<void, WorkspaceError>;
  /**
   * Takes over an active, frozen, or prepared orphan whose creating session provably ended; the
   * caller proves its writer stopped. Returns the handle naming the new owner.
   */
  readonly adopt: (target: WorkspaceAdoptTarget) => Effect.Effect<WorkspaceHandle, WorkspaceError>;
  /** Orphans unchanged for the minimum age that the sweep may discard. */
  readonly sweepCandidates: (input: {
    readonly minimumAgeMillis: number;
  }) => Effect.Effect<ReadonlyArray<WorkspaceRecord>, WorkspaceError>;
  /**
   * Freezes and discards one old orphan, keeping its revision patch until collection; undefined
   * when it is no longer eligible. The caller proves its writer stopped.
   */
  readonly sweepOrphan: (
    target: WorkspaceSweepTarget,
  ) => Effect.Effect<WorkspaceSwept | undefined, WorkspaceError>;
  /**
   * Runs WorktreeCreate hooks in order, stopping at the first failure; a timed-out or interrupted
   * hook's process group is killed. A failed or interrupted run in a prepared tree withdraws that
   * preparation.
   */
  readonly runCreateHooks: (
    target: WorkspaceHookTarget & {
      readonly hooks: ReadonlyArray<WorktreeHook>;
      /** The writer run the workspace belongs to, when known; hooks receive it on stdin. */
      readonly runId?: string | undefined;
    },
  ) => Effect.Effect<void, WorkspaceError>;
  /** Paths WorktreeCreate hooks changed relative to the tree they ran in. */
  readonly hookChanges: (
    target: WorkspaceHookTarget,
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
  readonly list: (input: {
    readonly ownerId: string;
  }) => Effect.Effect<ReadonlyArray<WorkspaceRecord>, WorkspaceError>;
  /** Every session's records, without probing their owner leases. */
  readonly listRecords: Effect.Effect<WorkspaceListing, WorkspaceError>;
  /** Every session's records, naming those whose owner lease is free (`endedOwners`). */
  readonly listAll: Effect.Effect<WorkspaceListing, WorkspaceError>;
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceContract>()(
  "pi-subagents/workspace/service/WorkspaceService",
) {
  static readonly layer = (options: {
    readonly agentDirectory: string;
    /** WorktreeRemove hooks, run before the engine removes any tree a workspace handed out. */
    readonly worktreeRemove?: ReadonlyArray<WorktreeHook> | undefined;
  }): Layer.Layer<WorkspaceService, WorkspaceError> =>
    Layer.unwrap(
      workspaceRegistry(options.agentDirectory).pipe(
        Effect.map((registry) =>
          WorkspaceService.layerAt(registry, options.worktreeRemove).pipe(
            Layer.provide(CrossProcessLock.layer({ directory: workspaceLockDirectory(registry) })),
          ),
        ),
      ),
    ).pipe(Layer.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer))));

  private static readonly layerAt = (
    registry: string,
    worktreeRemove: ReadonlyArray<WorktreeHook> | undefined,
  ) =>
    Layer.effect(
      WorkspaceService,
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        const engine = yield* gitWorkspaceEngine(registry, lock.withPermits(1), {
          worktreeRemove,
        });
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
          discard: (input) => run(engine.discard(input)),
          discardOrphan: (input) => run(engine.discardOrphan(input)),
          adopt: (input) => run(engine.adopt(input)),
          sweepCandidates: (input) => run(engine.sweepCandidates(input)),
          sweepOrphan: (input) => run(engine.sweepOrphan(input)),
          // WorktreeCreate hooks take the permit only around their record changes, never while
          // they run.
          runCreateHooks: (input) => provided(engine.runCreateHooks(input)),
          hookChanges: (input) => run(engine.hookChanges(input)),
          inspectWorkerChanges: (input) => run(engine.inspectWorkerChanges(input)),
          inspect: (input) => run(engine.inspect(input)),
          revision: (input) => run(engine.revision(input)),
          list: (input) => run(engine.list(input)),
          listRecords: run(engine.listRecords),
          listAll: run(engine.listAll),
        });
      }),
    );
}
