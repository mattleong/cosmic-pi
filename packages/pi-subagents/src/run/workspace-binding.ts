import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { WorktreeHook, WriterWorkspaceMode } from "../config/schema.ts";
import type { WriterLease } from "../boundary/writer-lease.ts";
import type { WorkspaceHandle, WorkspaceLaunch } from "../workspace/model.ts";
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
  /** Rebuild the worker tree from current parent files before the successor launches. */
  readonly rebase: boolean;
  launched: boolean;
}

/** How much of a revision's patch the parent has read, in UTF-16 units. */
export interface ReviewProgress {
  readonly revisionId: string;
  readonly reviewedThrough: number;
  readonly totalChars: number;
}

/**
 * What this session knows about the engine's current revision. The engine record may hold a
 * frozen or prepared revision this session has no knowledge of; only a recorded preparation is
 * integrable.
 */
export type RevisionKnowledge =
  | { readonly kind: "unreviewed" }
  /** Resume or revision admission made the engine's revision stale; the next review reopens it. */
  | { readonly kind: "reopened" }
  | { readonly kind: "frozen"; readonly review: ReviewProgress }
  | {
      readonly kind: "prepared";
      readonly revisionId: string;
      /** Recorded once its WorktreeCreate hooks succeeded; only a recorded preparation integrates. */
      readonly preparationId: string;
      /** Apply prepares without requiring any review. */
      readonly review?: ReviewProgress | undefined;
    };

/** States outside any launch or revision; a root operation may hold the binding in one. */
export type SettledBindingState =
  | { readonly phase: "idle"; readonly knowledge: RevisionKnowledge }
  /** Integration stopped mid-publication; discard rolls it back, then releases these leases. */
  | { readonly phase: "stopped-integration"; readonly leases: ReadonlyArray<WriterLease> }
  | {
      readonly phase: "finished";
      /** `unknown` when the integration's outcome couldn't be read afterwards. */
      readonly outcome: "integrated" | "discarded" | "auto-discarded" | "unknown";
    };

export type WorkspaceBindingState =
  /** Acquired by a launch not yet admitted or refused; `slot` is its parent's direct-child slot. */
  | { readonly phase: "creating"; readonly slot: LaunchSlot | undefined }
  /** A revise call holds the binding for its successor; a refused successor keeps `knowledge`. */
  | {
      readonly phase: "revising";
      readonly hold: RevisionHold;
      readonly slot: LaunchSlot | undefined;
      readonly knowledge: RevisionKnowledge;
    }
  /** Only the operation holding `token` is admitted; release restores `settled`. */
  | { readonly phase: "busy"; readonly token: symbol; readonly settled: SettledBindingState }
  | SettledBindingState;

export interface WorkspaceBinding {
  readonly handle: WorkspaceHandle;
  /**
   * The request a revision successor extends; a successor's admission replaces it. An adopted
   * orphan has none until its first successor: revise then launches its recorded `launch` afresh.
   */
  request?: StartSubagentRequest;
  /** An adopted orphan's recorded launch, which its first revision successor is resolved from. */
  readonly launch?: WorkspaceLaunch | undefined;
  /** The admitted writer; a successor's admission replaces it. */
  record?: RunRecord;
  state: WorkspaceBindingState;
}

export const UNREVIEWED: SettledBindingState = {
  phase: "idle",
  knowledge: { kind: "unreviewed" },
};

/** The settled state, looking through an operation's hold; undefined during launch or revision. */
export const settledState = ({ state }: WorkspaceBinding): SettledBindingState | undefined =>
  state.phase === "busy"
    ? state.settled
    : state.phase === "creating" || state.phase === "revising"
      ? undefined
      : state;

/** Replaces the settled state, keeping any operation's hold. */
export const settleBinding = (binding: WorkspaceBinding, next: SettledBindingState) => {
  const { state } = binding;
  binding.state = state.phase === "busy" ? { ...state, settled: next } : next;
};

export const revisionKnowledge = (binding: WorkspaceBinding): RevisionKnowledge | undefined => {
  if (binding.state.phase === "revising") return binding.state.knowledge;
  const settled = settledState(binding);
  return settled?.phase === "idle" ? settled.knowledge : undefined;
};

/** Updates what an idle or held binding knows about its revision. */
export const updateKnowledge = (
  binding: WorkspaceBinding,
  update: (knowledge: RevisionKnowledge) => RevisionKnowledge,
) => {
  const settled = settledState(binding);
  if (settled?.phase === "idle")
    settleBinding(binding, { phase: "idle", knowledge: update(settled.knowledge) });
};

export const reviewProgress = (knowledge: RevisionKnowledge | undefined) =>
  knowledge?.kind === "frozen" || knowledge?.kind === "prepared" ? knowledge.review : undefined;

/** Integrated, discarded, or left mid-integration: it never takes another assignment. */
export const isBindingFinished = (binding: WorkspaceBinding) => {
  const phase = settledState(binding)?.phase;
  return phase === "finished" || phase === "stopped-integration";
};

export const bindingSlot = ({ state }: WorkspaceBinding) =>
  state.phase === "creating" || state.phase === "revising" ? state.slot : undefined;

export const clearBindingSlot = (binding: WorkspaceBinding) => {
  const { state } = binding;
  if (state.phase === "creating" || state.phase === "revising")
    binding.state = { ...state, slot: undefined };
};

export type WorkspaceControlDependencies = Pick<
  RunContext,
  "ownerScope" | "records" | "withLock" | "writerLeases"
> & {
  readonly engine: WorkspaceServiceContract | undefined;
  readonly initialMode: WriterWorkspaceMode;
  /** Global then trusted-project WorktreeCreate hooks, run in every new worker and prepared tree. */
  readonly worktreeCreate: ReadonlyArray<WorktreeHook>;
  readonly ownerId: string;
  readonly sourceCwd?: string;
  readonly isClosed: () => boolean;
};

interface WorkspaceControlState {
  mode: WriterWorkspaceMode;
  readonly sharedReservations: Set<SharedReservation>;
  /** Session-wide: an integration's lease release or outcome is unknown. Cleared only by restart. */
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
  readonly code?: string | undefined;
}) =>
  invalid(
    error.code ?? "workspace_operation_failed",
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

const isAutoDiscarded = (binding: WorkspaceBinding | undefined) => {
  const settled = binding && settledState(binding);
  return settled?.phase === "finished" && settled.outcome === "auto-discarded";
};

export const workspaceFinishedError = (binding?: WorkspaceBinding) =>
  invalid(
    "workspace_finished",
    isAutoDiscarded(binding)
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
  binding.state = { phase: "idle", knowledge: { kind: "reopened" } };
};

export const workspaceBusyError = () =>
  invalid(
    "workspace_operation_in_progress",
    "Another operation on this workspace is still running. Retry once it finishes.",
  );

/**
 * Refuses a workspace whose worktree hook may still own processes, from the engine's durable
 * marker. The read takes no engine lock, so callers may hold the run lock.
 */
export const requireHooksSettled = (
  engine: WorkspaceServiceContract | undefined,
  binding: WorkspaceBinding,
  message: string,
): Effect.Effect<void, SubagentError> =>
  engine
    ? engine.hookCleanupPending({ workspaceId: binding.handle.workspaceId }).pipe(
        Effect.mapError(mapWorkspaceError),
        Effect.flatMap((pending) =>
          pending ? Effect.fail(invalid("workspace_process_unsettled", message)) : Effect.void,
        ),
      )
    : Effect.void;

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
      (child) => child.handle.sourceWorkspaceId === workspaceId && !isBindingFinished(child),
    );
    // A child launch from any run of this workspace may still be creating its workspace.
    const callers = new Set(
      [...records.values()].flatMap((record) =>
        record.view.workspaceId === workspaceId ? [record.view.id] : [],
      ),
    );
    const creating =
      [...state.launchSlots].filter(
        (slot) =>
          callers.has(slot.caller) && !children.some((child) => bindingSlot(child) === slot),
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
          `Child workspaces created from this workspace are unresolved (${pending}). The writer that started them must apply or discard them first; once that writer has stopped, discard them directly, children before their parent.`,
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
      if (isAutoDiscarded(binding)) return yield* workspaceFinishedError(binding);
      const { state: current } = binding;
      if (current.phase === "busy" && current.token !== held) return yield* workspaceBusyError();
      if (
        current.phase === "creating" ||
        current.phase === "revising" ||
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
      yield* requireHooksSettled(
        engine,
        binding,
        "Worktree hook cleanup is unconfirmed. Independently confirm the hook's process and all descendants have stopped, preserve the proposal and recovery record, then recover the private trees manually. Restarting Pi does not clear this quarantine.",
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
