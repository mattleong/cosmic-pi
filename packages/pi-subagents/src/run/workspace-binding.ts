import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { WorktreeHook, WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle, WorkspaceLaunch } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isCleanupOwed, type RunContext, type RunRecord, type StoredRunView } from "./internal.ts";
import {
  isActiveRunState,
  type StartSubagentRequest,
  type SubagentWorkspaceOutcome,
} from "./model.ts";

export interface LaunchSlot {
  readonly caller: string;
}

/** A shared-checkout launch between mode selection and admission, keyed by its target cwd. */
export interface SharedReservation {
  readonly cwd: string;
  readonly caller: string;
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
  ) => Effect.Effect<WorkspaceBinding, SubagentError>;
  /**
   * Waits, interruptibly, for the bound writer's process cleanup once it finished, so operations
   * right after its report need no retry. A running writer or quarantined cleanup is left for
   * `requireBinding` to refuse.
   */
  readonly awaitWriterCleanup: (workspaceId: string) => Effect.Effect<void, SubagentError>;
  readonly operations: Semaphore.Semaphore;
}

const WRITER_CLEANUP_WAIT = "30 seconds";

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
  isActiveRunState(record.view.state) || record.process !== undefined || isCleanupOwed(record);

export const runsWithin = (
  records: ReadonlyMap<string, RunRecord>,
  trees: ReadonlyArray<string>,
  except?: RunRecord,
): ReadonlyMap<RunRecord, StoredRunView> =>
  new Map(
    [...records.values()].flatMap(
      (record): ReadonlyArray<readonly [RunRecord, StoredRunView]> =>
        record !== except && trees.some((tree) => isWithin(record.view.cwd, tree))
          ? [[record, record.view]]
          : [],
    ),
  );

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
  const requireBinding = (workspaceId: string, caller: string, held?: symbol) =>
    Effect.gen(function* () {
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
          "The workspace writer's process cleanup is quarantined. Inspect it with agent_read and recover it first.",
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
      const sharedWriter = [
        ...runsWithin(records, [binding.handle.artifactRoot], binding.record).keys(),
      ].some((record) => record.view.writeIntent === "writer" && runHoldsCwd(record));
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
                        "The workspace writer's process cleanup is still settling. Retry shortly.",
                      ),
                    ),
                }),
              ),
        ),
      );
  return {
    ...dependencies,
    state,
    ownerFor,
    requireEngine,
    requireBinding,
    awaitWriterCleanup,
    operations: Semaphore.makeUnsafe(1),
  };
}
