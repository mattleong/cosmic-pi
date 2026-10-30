import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";
import type { WorktreeCreateSetup, WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle, WorkspaceLaunch } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import {
  guidedText,
  type GuidedText,
  invalidRequest as invalid,
  type SubagentError,
  withGuidance,
} from "./errors.ts";
import { isCleanupOwed, type RunContext, type RunRecord, type StoredRunView } from "./internal.ts";
import {
  isActiveRunState,
  type StartSubagentRequest,
  type SubagentWorkspaceOutcome,
} from "./model.ts";
import { runInSessionScope } from "./session-owned.ts";

export interface LaunchSlot {
  readonly caller: string;
}

/**
 * A read-only or shared-checkout launch between its workspace checks and admission, keyed by its
 * target cwd.
 */
export interface LaunchReservation {
  readonly cwd: string;
  readonly caller: string;
  /** A shared-checkout writer; integration refuses while one launches in its target. */
  readonly sharedWriter: boolean;
}

/**
 * The directories destructive engine work changes outside the run lock. Until it ends, launches
 * there wait and resumes there refuse, so no run takes a tree it removes or sees a checkout it is
 * half-way through writing. Worktree launches need no exclusion: the engine's operation gate
 * queues their snapshots behind the work.
 */
export interface WorkspaceExclusion {
  /** Discard and integration remove the workspace's trees. */
  readonly artifactRoot: string;
  /** Integration and rollback write this checkout's files. */
  readonly target?: string | undefined;
}

export interface RevisionHold {
  readonly successor: StartSubagentRequest;
  /** Rebuild the worker tree from current parent files before the successor launches. */
  readonly rebase: boolean;
  launched: boolean;
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
  /** The parent reviewed the current revision, so automatic cleanup leaves it alone. */
  | { readonly kind: "frozen" }
  | {
      readonly kind: "prepared";
      readonly revisionId: string;
      /** Recorded once ready, after any WorktreeCreate hooks; only a recorded preparation integrates. */
      readonly preparationId: string;
      /** `prepare` builds a tree for the parent to test; a one-call apply's tree runs no hooks. */
      readonly origin: "prepare" | "apply";
    };

/** States outside any launch or revision; a root operation may hold the binding in one. */
type SettledBindingState =
  | { readonly phase: "idle"; readonly knowledge: RevisionKnowledge }
  /** Integration stopped partway; only discard, which rolls it back, may follow. */
  | { readonly phase: "stopped-integration" }
  | {
      readonly phase: "finished";
      /** `unknown` when the integration's outcome couldn't be read afterwards. */
      readonly outcome: "integrated" | "discarded" | "auto-discarded" | "unknown";
    };

type WorkspaceBindingState =
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

/** A binding an operation keeps busy; `heldLocked` confirms, under the run lock, it still does. */
export interface HeldBinding {
  readonly binding: WorkspaceBinding;
  readonly token: symbol;
  readonly heldLocked: Effect.Effect<void, SubagentError>;
}

/**
 * Marks a settled binding busy for one operation, which its token alone then admits; undefined
 * while a launch, revision, or another operation holds it.
 */
export const holdBindingLocked = (
  bindings: ReadonlyMap<string, WorkspaceBinding>,
  binding: WorkspaceBinding,
): HeldBinding | undefined => {
  const { state } = binding;
  if (state.phase === "busy" || state.phase === "creating" || state.phase === "revising")
    return undefined;
  const token = Symbol("workspace operation");
  binding.state = { phase: "busy", token, settled: state };
  return {
    binding,
    token,
    heldLocked: Effect.suspend(() =>
      bindings.get(binding.handle.workspaceId) === binding &&
      binding.state.phase === "busy" &&
      binding.state.token === token
        ? Effect.void
        : Effect.fail(
            invalid(
              "workspace_owner_unavailable",
              "Workspace ownership changed while the operation was running.",
            ),
          ),
    ),
  };
};

/** Ends an operation's hold, restoring the settled state it kept unless the hold already ended. */
export const releaseBindingLocked = ({ binding, token }: HeldBinding) => {
  const { state } = binding;
  if (state.phase === "busy" && state.token === token) binding.state = state.settled;
};

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
  readonly worktreeCreate: WorktreeCreateSetup;
  readonly ownerId: string;
  readonly sourceCwd?: string;
  readonly isClosed: () => boolean;
};

interface WorkspaceControlState {
  mode: WriterWorkspaceMode;
  readonly launchReservations: Set<LaunchReservation>;
  /** Destructive engine work running outside the run lock; see `excludeTrees`. */
  readonly exclusions: Set<WorkspaceExclusion>;
  /** Completes when an exclusion ends, waking the launches it held. */
  exclusionReleased: Deferred.Deferred<void>;
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
  ) => Effect.Effect<WorkspaceBinding, SubagentError>;
  /**
   * Waits, interruptibly, for the bound writer's process cleanup once it finished, so operations
   * right after its report need no retry. A running writer or quarantined cleanup is left for
   * `requireBinding` to refuse.
   */
  readonly awaitWriterCleanup: (workspaceId: string) => Effect.Effect<void, SubagentError>;
  /**
   * Runs destructive engine work outside the run lock. `claimLocked` checks occupancy under the
   * lock and names the directories the work changes, which stay excluded until it ends. The work
   * runs in the session scope, so shutdown interrupts and joins it, and commits its own outcome
   * under the lock.
   */
  readonly excludeTrees: <C extends { readonly exclusion: WorkspaceExclusion }, A>(
    claimLocked: Effect.Effect<C, SubagentError>,
    work: (claim: C) => Effect.Effect<A, SubagentError>,
  ) => Effect.Effect<A, SubagentError>;
  readonly operations: Semaphore.Semaphore;
}

const WRITER_CLEANUP_WAIT = "30 seconds";

/** A workspace error's text: its message and detail, then, for the model only, its remedy. */
export const workspaceErrorText = (error: {
  readonly message: string;
  readonly detail?: string | undefined;
  readonly remedy?: string | undefined;
}): GuidedText => {
  const facts = error.detail === undefined ? error.message : `${error.message}\n${error.detail}`;
  return error.remedy === undefined
    ? guidedText(facts)
    : withGuidance(facts, `Remedy: ${error.remedy}`, "\n");
};

export const mapWorkspaceError = (error: {
  readonly message: string;
  readonly detail?: string | undefined;
  readonly remedy?: string | undefined;
  readonly code?: string | undefined;
}) => invalid(error.code ?? "workspace_operation_failed", workspaceErrorText(error));

export const isWithin = (cwd: string, root: string) =>
  cwd === root || Fn.pipe(cwd, Str.startsWith(`${Fn.pipe(root, Str.replace(/\/$/, ""))}/`));

export const overlaps = (cwd: string, root: string) => isWithin(cwd, root) || isWithin(root, cwd);

/** Whether destructive work excludes a run in `cwd`. */
export const isExcluded = (exclusions: ReadonlySet<WorkspaceExclusion>, cwd: string) =>
  Arr.some(
    [...exclusions],
    ({ artifactRoot, target }) =>
      isWithin(cwd, artifactRoot) || (target !== undefined && overlaps(cwd, target)),
  );

export const runHoldsCwd = (record: RunRecord) =>
  isActiveRunState(record.view.state) || record.process !== undefined || isCleanupOwed(record);

export const runsWithin = (
  records: ReadonlyMap<string, RunRecord>,
  trees: ReadonlyArray<string>,
  except?: RunRecord,
): ReadonlyMap<RunRecord, StoredRunView> =>
  new Map(
    Arr.flatMap(
      [...records.values()],
      (record): ReadonlyArray<readonly [RunRecord, StoredRunView]> =>
        record !== except && Arr.some(trees, (tree) => isWithin(record.view.cwd, tree))
          ? [[record, record.view]]
          : [],
    ),
  );

/** Whether a run holds, or a launch is about to take, a directory within `tree`. */
export const isTreeInUse = (
  records: ReadonlyMap<string, RunRecord>,
  reservations: ReadonlySet<LaunchReservation>,
  tree: string,
) =>
  Arr.some([...runsWithin(records, [tree]).keys()], runHoldsCwd) ||
  Arr.some([...reservations], (reservation) => isWithin(reservation.cwd, tree));

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

/** Records how the workspace was resolved on its writer's view; callers publish under the run lock. */
export const recordWorkspaceOutcomeLocked = (
  binding: WorkspaceBinding,
  workspaceOutcome: SubagentWorkspaceOutcome,
) => {
  const record = binding.record;
  if (record) record.view = { ...record.view, workspaceOutcome };
};

export const workspaceBusyError = () =>
  invalid(
    "workspace_operation_in_progress",
    withGuidance(
      "Another operation on this workspace is still running.",
      "Retry once it finishes.",
    ),
  );

export const workspaceControlContext = Effect.fn("SubagentWorkspace.controlContext")(function* (
  dependencies: WorkspaceControlDependencies,
): Effect.fn.Return<WorkspaceControlContext> {
  const { engine, ownerId, records } = dependencies;
  const state: WorkspaceControlState = {
    mode: dependencies.initialMode,
    launchReservations: new Set(),
    exclusions: new Set(),
    exclusionReleased: yield* Deferred.make<void>(),
    integrationQuarantined: false,
    bindings: new Map(),
    launchSlots: new Set(),
    slotReleased: yield* Deferred.make<void>(),
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
  const requireBinding = Effect.fn("SubagentWorkspace.requireBinding")(function* (
    workspaceId: string,
    caller: string,
    held?: symbol,
  ) {
    const binding = state.bindings.get(workspaceId);
    if (!binding || binding.handle.ownerId !== ownerFor(caller))
      return yield* invalid(
        "workspace_owner_unavailable",
        "Workspace mutation requires its authenticated direct parent and live coordinator ownership evidence. Persisted artifacts without cleanup evidence require manual recovery.",
      );
    if (isAutoDiscarded(binding)) return yield* workspaceFinishedError(binding);
    const { state: current } = binding;
    if (current.phase === "busy" && current.token !== held) return yield* workspaceBusyError();
    if (current.phase === "creating" || current.phase === "revising")
      return yield* invalid(
        "workspace_process_unsettled",
        "A writer is still launching in this workspace. Await it first.",
      );
    const writer = binding.record;
    if (writer?.cleanupDisposition === "quarantined")
      return yield* invalid(
        "workspace_process_unsettled",
        withGuidance(
          "The workspace writer's process cleanup is quarantined.",
          "Inspect it with agent_read and recover it first.",
        ),
      );
    if (
      writer &&
      (writer.process !== undefined ||
        writer.cleanupDisposition !== "confirmed" ||
        isActiveRunState(writer.view.state))
    )
      return yield* invalid(
        "workspace_process_unsettled",
        "The workspace writer is still running. Await or stop it first.",
      );
    // A shared-checkout writer its writer started may still be editing the worker tree; readers
    // there are fine, because integration keeps the trees they use.
    const sharedWriter = Arr.some(
      [...runsWithin(records, [binding.handle.artifactRoot], binding.record).keys()],
      (record) => record.view.writeIntent === "writer" && runHoldsCwd(record),
    );
    if (sharedWriter)
      return yield* invalid(
        "workspace_process_unsettled",
        "A writer still works in this workspace's tree. Await or stop it first.",
      );
    return binding;
  });
  const awaitWriterCleanup = (workspaceId: string) =>
    dependencies
      .withLock(
        Effect.sync(() => {
          const record = state.bindings.get(workspaceId)?.record;
          return record &&
            !isActiveRunState(record.view.state) &&
            (record.cleanupDisposition === "pending" ||
              (record.cleanupDisposition === "none" && record.process !== undefined))
            ? record.cleanupSettlement
            : undefined;
        }),
      )
      .pipe(
        Effect.flatMap((settlement) =>
          settlement === undefined
            ? Effect.void
            : Deferred.await(settlement).pipe(
                Effect.asVoid,
                Effect.timeoutOrElse({
                  duration: WRITER_CLEANUP_WAIT,
                  orElse: () =>
                    Effect.fail(
                      invalid(
                        "workspace_process_unsettled",
                        withGuidance(
                          "The workspace writer's process cleanup is still settling.",
                          "Retry shortly.",
                        ),
                      ),
                    ),
                }),
              ),
        ),
      );
  const releaseExclusionLocked = (exclusion: WorkspaceExclusion) => {
    if (!state.exclusions.delete(exclusion)) return;
    const released = state.exclusionReleased;
    state.exclusionReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  };
  const excludeTrees: WorkspaceControlContext["excludeTrees"] = (claimLocked, work) =>
    Effect.acquireUseRelease(
      dependencies.withLock(
        claimLocked.pipe(
          Effect.tap(({ exclusion }) => Effect.sync(() => state.exclusions.add(exclusion))),
        ),
      ),
      (claim) => runInSessionScope(dependencies.ownerScope, work(claim)),
      ({ exclusion }) =>
        dependencies.withLock(Effect.sync(() => releaseExclusionLocked(exclusion))),
    );
  return {
    ...dependencies,
    state,
    ownerFor,
    requireEngine,
    requireBinding,
    awaitWriterCleanup,
    excludeTrees,
    operations: yield* Semaphore.make(1),
  };
});
