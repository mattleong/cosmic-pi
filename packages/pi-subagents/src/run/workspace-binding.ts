import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { WorkspaceSetup, WorkspaceVerify, WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import {
  isActiveRunState,
  isTerminalRunState,
  type StartSubagentRequest,
  SUBAGENT_ROOT_RUN_ID,
  type SubagentRunView,
} from "./model.ts";
import { isRunInSubtree } from "./tree.ts";

export interface LaunchSlot {
  readonly caller: string;
}

/** A shared-checkout launch between mode selection and admission, keyed by its target cwd. */
export interface SharedReservation {
  readonly cwd: string;
  readonly caller: string;
}

/**
 * `discard` additionally admits the root or an ancestor of the workspace's direct parent once that
 * parent run is inactive; every other operation requires the direct parent.
 */
export type WorkspaceAccess = "owner" | "discard";

export interface RevisionHold {
  readonly successor: StartSubagentRequest;
  launched: boolean;
}

export interface WorkspaceBinding {
  readonly handle: WorkspaceHandle;
  request: StartSubagentRequest;
  record?: RunRecord;
  preparing: boolean;
  setupCleanupPending?: boolean | undefined;
  busy?: symbol | undefined;
  reopenPending?: boolean | undefined;
  reviewedRevision?: string | undefined;
  reviewedThrough?: number | undefined;
  /** The preparation whose setup succeeded; an engine-prepared tree without it is untested. */
  testedPreparation?: string | undefined;
  /** A preparation whose verification failed; it stays inspectable but is never integrable. */
  verificationFailedPreparation?: string | undefined;
  finished?: boolean | undefined;
  /** Discarded by the coordinator because its completed writer changed nothing. */
  autoDiscarded?: boolean | undefined;
  integrated?: boolean | undefined;
  slot?: LaunchSlot | undefined;
  revision?: RevisionHold | undefined;
}

export type WorkspaceControlDependencies = Pick<
  RunContext,
  "ownerScope" | "records" | "withLock" | "writerLeases"
> & {
  readonly engine: WorkspaceServiceContract | undefined;
  readonly initialMode: WriterWorkspaceMode;
  readonly workspaceSetup?: WorkspaceSetup | undefined;
  readonly workspaceVerify?: WorkspaceVerify | undefined;
  readonly ownerId: string;
  readonly sourceCwd?: string;
  readonly isClosed: () => boolean;
};

interface WorkspaceControlState {
  mode: WriterWorkspaceMode;
  readonly sharedReservations: Set<SharedReservation>;
  integrationQuarantined: boolean;
  readonly bindings: Map<string, WorkspaceBinding>;
  readonly launchSlots: Set<LaunchSlot>;
  slotReleased: Deferred.Deferred<void>;
}

export interface WorkspaceControlContext extends WorkspaceControlDependencies {
  readonly state: WorkspaceControlState;
  readonly ownerFor: (caller: string) => string;
  readonly requireEngine: Effect.Effect<WorkspaceServiceContract, SubagentError>;
  /** `held` admits the binding while that operation token keeps it busy. */
  readonly requireBinding: (
    workspaceId: string,
    caller: string,
    held?: symbol,
    access?: WorkspaceAccess,
  ) => Effect.Effect<WorkspaceBinding, SubagentError>;
  /**
   * Refuses a workspace whose worker tree is the source of unresolved child workspaces, including
   * children still being created and durable ones this session doesn't bind. Callers hold the run
   * lock.
   */
  readonly requireChildrenResolved: (
    binding: WorkspaceBinding,
  ) => Effect.Effect<void, SubagentError>;
  /** Unresolved child workspaces this session binds, and child launches still creating theirs. */
  readonly unresolvedChildrenLocked: (binding: WorkspaceBinding) => {
    readonly workspaceIds: ReadonlyArray<string>;
    readonly creating: number;
  };
  readonly operations: Semaphore.Semaphore;
}

export const mapWorkspaceError = (error: {
  readonly message: string;
  readonly detail?: string | undefined;
}) =>
  invalid(
    "workspace_operation_failed",
    error.detail === undefined ? error.message : `${error.message}\n${error.detail}`,
  );

export const isWithin = (cwd: string, root: string) =>
  cwd === root || cwd.startsWith(`${root.replace(/\/$/, "")}/`);

export const runHoldsCwd = (record: RunRecord) =>
  isActiveRunState(record.view.state) || record.process !== undefined || record.cleanupPending;

export const runsWithin = (
  records: ReadonlyMap<string, RunRecord>,
  trees: ReadonlyArray<string>,
  except?: RunRecord,
): ReadonlyMap<RunRecord, SubagentRunView> =>
  new Map(
    [...records.values()].flatMap(
      (record): ReadonlyArray<readonly [RunRecord, SubagentRunView]> =>
        record !== except && trees.some((tree) => isWithin(record.view.cwd, tree))
          ? [[record, record.view]]
          : [],
    ),
  );

/** The engine validates this layout; never infer a broader root from an unrelated path. */
export const workspaceArtifactDirectory = (handle: WorkspaceHandle): string | undefined => {
  if (!isWithin(handle.sourceCwd, handle.sourceRoot)) return undefined;
  const sourceSuffix = handle.sourceCwd.slice(handle.sourceRoot.replace(/\/$/u, "").length);
  if (sourceSuffix.split("/").some((part) => part === "." || part === "..")) return undefined;
  const workerSuffix = `/worker${sourceSuffix}`;
  if (!handle.cwd.endsWith(workerSuffix)) return undefined;
  const directory = handle.cwd.slice(0, -workerSuffix.length);
  return directory.endsWith(`/${handle.workspaceId}`) ? directory : undefined;
};

export const workspaceFinishedError = (binding?: WorkspaceBinding) =>
  invalid(
    "workspace_finished",
    binding?.autoDiscarded
      ? "This workspace was discarded automatically because its writer completed without changes. Start a new writer instead."
      : "This workspace was integrated or discarded and cannot take another assignment.",
  );

/**
 * Admission or resume makes the reviewed revision, its tested preparation, and the writer's
 * settled workspace outcome stale.
 */
export const reopenBindingLocked = (binding: WorkspaceBinding) => {
  const record = binding.record;
  if (record?.view.workspaceOutcome) record.view = { ...record.view, workspaceOutcome: undefined };
  binding.reopenPending = true;
  binding.reviewedRevision = undefined;
  binding.reviewedThrough = undefined;
  binding.testedPreparation = undefined;
  binding.verificationFailedPreparation = undefined;
};

export const workspaceBusyError = () =>
  invalid(
    "workspace_operation_in_progress",
    "Another operation on this workspace is still running. Retry once it finishes.",
  );

export function workspaceControlContext(
  dependencies: WorkspaceControlDependencies,
): WorkspaceControlContext {
  const { engine, ownerId, records } = dependencies;
  const state: WorkspaceControlState = {
    mode: dependencies.initialMode,
    sharedReservations: new Set(),
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
  /**
   * The escape hatch once a nested workspace's direct parent can no longer resolve it: that run
   * is terminal with confirmed cleanup, or gone. Ancestry comes from authenticated run records.
   */
  const ancestorMayDiscard = (binding: WorkspaceBinding, caller: string) => {
    const prefix = ownerFor("");
    if (!binding.handle.ownerId.startsWith(prefix)) return false;
    const parentRunId = binding.handle.ownerId.slice(prefix.length);
    if (parentRunId === SUBAGENT_ROOT_RUN_ID || parentRunId === caller) return false;
    const parent = records.get(parentRunId);
    if (!parent) return caller === SUBAGENT_ROOT_RUN_ID;
    return (
      isTerminalRunState(parent.view.state) &&
      parent.process === undefined &&
      !parent.cleanupPending &&
      parent.cleanupDisposition === "confirmed" &&
      (caller === SUBAGENT_ROOT_RUN_ID || isRunInSubtree(records, caller, parentRunId))
    );
  };
  const unresolvedChildrenLocked = (binding: WorkspaceBinding) => {
    const { workspaceId } = binding.handle;
    const children = [...state.bindings.values()].filter(
      (child) => child.handle.sourceWorkspaceId === workspaceId && !child.finished,
    );
    // A child launch from any run of this workspace may still be creating its workspace.
    const callers = new Set(
      [...records.values()].flatMap((record) =>
        record.view.workspaceId === workspaceId ? [record.view.id] : [],
      ),
    );
    const creating =
      [...state.launchSlots].filter(
        (slot) => callers.has(slot.caller) && !children.some((child) => child.slot === slot),
      ).length +
      [...state.sharedReservations].filter((reservation) => callers.has(reservation.caller)).length;
    return { workspaceIds: children.map((child) => child.handle.workspaceId), creating };
  };
  const requireChildrenResolved = (binding: WorkspaceBinding) =>
    Effect.gen(function* () {
      const local = unresolvedChildrenLocked(binding);
      const durable = engine
        ? yield* engine
            .unresolvedChildren({ workspaceId: binding.handle.workspaceId })
            .pipe(Effect.mapError(mapWorkspaceError))
        : [];
      const workspaceIds = [...new Set([...local.workspaceIds, ...durable])].toSorted();
      if (workspaceIds.length > 0 || local.creating > 0) {
        const pending = [
          ...(workspaceIds.length > 0 ? [workspaceIds.join(", ")] : []),
          ...(local.creating > 0 ? [`${local.creating} still being created`] : []),
        ].join("; ");
        return yield* invalid(
          "workspace_children_unresolved",
          `Child workspaces created from this workspace are unresolved (${pending}). The writer that started them must integrate or discard them first; once that writer has stopped, discard them directly, children before their parent.`,
        );
      }
      return undefined;
    });
  const requireBinding = (
    workspaceId: string,
    caller: string,
    held?: symbol,
    access: WorkspaceAccess = "owner",
  ) =>
    Effect.gen(function* () {
      const binding = state.bindings.get(workspaceId);
      if (
        !binding ||
        (binding.handle.ownerId !== ownerFor(caller) &&
          !(access === "discard" && ancestorMayDiscard(binding, caller)))
      )
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace mutation requires its authenticated direct parent and live coordinator ownership evidence. Persisted artifacts without cleanup evidence require manual recovery.",
        );
      if (binding.autoDiscarded) return yield* workspaceFinishedError(binding);
      if (binding.busy !== undefined && binding.busy !== held) return yield* workspaceBusyError();
      if (binding.setupCleanupPending)
        return yield* invalid(
          "workspace_process_unsettled",
          "Workspace setup cleanup is unconfirmed. Independently confirm the setup process and all descendants have stopped, preserve the proposal and recovery record, then recover the private trees manually. Restarting Pi does not clear this quarantine.",
        );
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
      // A shared-checkout writer its writer started may still be editing the worker tree; readers
      // there are fine, because integration keeps the trees they use.
      const directory = workspaceArtifactDirectory(binding.handle);
      const sharedWriter =
        directory &&
        [...runsWithin(records, [directory], binding.record).keys()].some(
          (record) => record.view.writeIntent === "writer" && runHoldsCwd(record),
        );
      if (sharedWriter)
        return yield* invalid(
          "workspace_process_unsettled",
          "A writer still works in this workspace's tree. Stop it and confirm cleanup before reviewing or changing the artifact.",
        );
      return binding;
    });
  return {
    ...dependencies,
    state,
    ownerFor,
    requireEngine,
    requireBinding,
    requireChildrenResolved,
    unresolvedChildrenLocked,
    operations: Semaphore.makeUnsafe(1),
  };
}
