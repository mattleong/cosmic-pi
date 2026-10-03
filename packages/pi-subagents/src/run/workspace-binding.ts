import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { isActiveRunState, type StartSubagentRequest } from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

/**
 * One worktree launch's hold on a direct-child slot, from its capacity check until admission
 * holds that slot itself, through the admitted writer or an eviction claim, or the launch fails.
 */
export interface LaunchSlot {
  readonly caller: string;
  /** Identity of the hold in admission-signal snapshots. */
  readonly id: number;
}

/** A revision holding its binding from its reservation until its successor's launch settles. */
export interface WorkspaceRevision {
  /** What the successor launches with; the binding's request once the successor is admitted. */
  readonly successor: StartSubagentRequest;
  /** The successor's launch took over this hold. Until then the revise call releases it. */
  launched: boolean;
}

/** A live coordinator's ownership of one writer workspace. */
export interface WorkspaceBinding {
  readonly handle: WorkspaceHandle;
  /**
   * What a revision successor launches with: the writer's request without owner-only fields.
   * Replaced only once a successor is admitted.
   */
  request: StartSubagentRequest;
  record?: RunRecord;
  preparing: boolean;
  /** The operation holding this binding outside the run lock: a resume, or a root operation. */
  busy?: number | undefined;
  /**
   * A later assignment, a resume or a revision successor, invalidated the reviewed revision and
   * preparation that the engine record still holds. The next review reopens the record before
   * freezing; until then the stale revision and preparation are refused and hidden.
   */
  reopenPending?: boolean | undefined;
  reviewedRevision?: string | undefined;
  reviewedThrough?: number | undefined;
  /**
   * This coordinator integrated or discarded the workspace, or left its integration uncertain.
   * It takes no further assignment, though a kept worker can still be discarded.
   */
  finished?: boolean | undefined;
  /** This coordinator committed the workspace's integration; a later discard keeps this. */
  integrated?: boolean | undefined;
  /** The slot of the worktree launch now admitting a writer into this workspace. */
  slot?: LaunchSlot | undefined;
  /** The revision holding this binding, with `preparing`, while its successor launches. */
  revision?: WorkspaceRevision | undefined;
}

export type WorkspaceControlDependencies = Omit<RunContext, "writerPools"> & {
  readonly writerPools: ReadonlyMap<string, WriterPoolEntry>;
  readonly engine: WorkspaceServiceContract | undefined;
  readonly initialMode: WriterWorkspaceMode;
  readonly ownerId: string;
  readonly sourceCwd?: string;
  readonly isClosed: () => boolean;
};

/** Coordinator state shared by launch, review and integration; mutated under the run lock. */
export interface WorkspaceControlState {
  mode: WriterWorkspaceMode;
  /** Writer launches between mode selection and admission. */
  reservations: number;
  /** An integration whose lease release or outcome is unconfirmed blocks writer admission. */
  integrationQuarantined: boolean;
  readonly bindings: Map<string, WorkspaceBinding>;
  /** Worktree launches that hold a direct-child slot while they acquire their workspaces. */
  readonly launchSlots: Set<LaunchSlot>;
  /** Completed, then replaced, whenever a launch slot is released. */
  slotReleased: Deferred.Deferred<void>;
}

export interface WorkspaceControlContext extends WorkspaceControlDependencies {
  readonly state: WorkspaceControlState;
  readonly ownerFor: (caller: string) => string;
  readonly requireEngine: Effect.Effect<WorkspaceServiceContract, SubagentError>;
  /** Under the run lock: the caller's binding, once its writer process is settled. */
  readonly requireBinding: (
    workspaceId: string,
    caller: string,
  ) => Effect.Effect<WorkspaceBinding, SubagentError>;
  /**
   * Serializes root workspace operations. Each holds its binding busy and calls the engine
   * outside the run lock, so the next root operation waits here rather than being refused.
   */
  readonly operations: Semaphore.Semaphore;
  /** A fresh token for `WorkspaceBinding.busy`. */
  readonly nextOperation: () => number;
}

export const mapWorkspaceError = (error: { readonly message: string }) =>
  invalid("workspace_operation_failed", error.message);

export const workspaceFinishedError = () =>
  invalid(
    "workspace_finished",
    "This workspace was integrated or discarded and cannot take another assignment.",
  );

export const workspaceBusyError = () =>
  invalid(
    "workspace_operation_in_progress",
    "Another operation on this workspace is still running. Retry once it finishes.",
  );

/**
 * What this session's coordinator knows of a writer workspace: still awaiting review, its
 * integration committed, closed without a committed integration (discarded, or its integration
 * left uncertain), or never bound by this coordinator, such as one an earlier activation made.
 */
export type WorkspaceBindingStatus = "pending" | "integrated" | "closed" | "unbound";

/** Under the run lock: the status of `workspaceId` as this coordinator's binding records it. */
export const workspaceBindingStatusLocked = (
  state: WorkspaceControlState,
  workspaceId: string,
): WorkspaceBindingStatus => {
  const binding = state.bindings.get(workspaceId);
  if (!binding) return "unbound";
  if (!binding.finished) return "pending";
  return binding.integrated ? "integrated" : "closed";
};

export function makeWorkspaceControlContext(
  dependencies: WorkspaceControlDependencies,
): WorkspaceControlContext {
  const { engine, ownerId } = dependencies;
  const state: WorkspaceControlState = {
    mode: dependencies.initialMode,
    reservations: 0,
    integrationQuarantined: false,
    bindings: new Map(),
    launchSlots: new Set(),
    slotReleased: Deferred.makeUnsafe<void>(),
  };
  const ownerFor = (caller: string) => `${ownerId}/${caller}`;
  const requireEngine = engine
    ? Effect.succeed(engine)
    : Effect.fail(
        invalid(
          "workspace_unavailable",
          "Private workspace service is unavailable. Writer launch is denied.",
        ),
      );
  const requireBinding = (workspaceId: string, caller: string) =>
    Effect.gen(function* () {
      const binding = state.bindings.get(workspaceId);
      if (!binding || binding.handle.ownerId !== ownerFor(caller))
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace mutation requires its authenticated direct parent and live coordinator ownership evidence. Persisted artifacts without cleanup evidence require manual recovery.",
        );
      if (binding.busy !== undefined) return yield* workspaceBusyError();
      if (
        binding.preparing ||
        (binding.record &&
          (binding.record.process !== undefined ||
            binding.record.cleanupPending ||
            binding.record.cleanupDisposition !== "confirmed" ||
            isActiveRunState(binding.record.view.state)))
      )
        return yield* invalid(
          "workspace_process_unsettled",
          "Stop the workspace writer and confirm complete process cleanup before reviewing or changing its artifact.",
        );
      return binding;
    });
  let operationTokens = 0;
  return {
    ...dependencies,
    state,
    ownerFor,
    requireEngine,
    requireBinding,
    operations: Semaphore.makeUnsafe(1),
    nextOperation: () => ++operationTokens,
  };
}
