import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { DEFAULT_SUBAGENT_NESTING_POLICY, type WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import { type HeldLaunchSlots, processCapacityError, workflowCapacityError } from "./admission.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID, type StartSubagentRequest, type SubagentRunView } from "./model.ts";
import {
  type LaunchSlot,
  mapWorkspaceError,
  type WorkspaceBinding,
  type WorkspaceControlContext,
  type WorkspaceRevision,
  workspaceBusyError,
  workspaceFinishedError,
} from "./workspace-binding.ts";

type WorkspaceStart = (
  request: StartSubagentRequest,
) => Effect.Effect<SubagentRunView, SubagentError>;

/** The writer mode a launch uses, and the slot release it must first wait for, if any. */
interface LaunchSelection {
  readonly mode: WriterWorkspaceMode;
  readonly slotWait?: Deferred.Deferred<void>;
}

/** A launch as a revision successor reusing a workspace, or as an owned start. */
interface LaunchOptions {
  readonly reuse?: WorkspaceHandle | undefined;
  /** The run id an owned start reserved. */
  readonly runId?: string | undefined;
}

/** A revision successor's launch: the binding it reuses, and the revision whose hold it took. */
interface Succession {
  readonly binding: WorkspaceBinding;
  readonly revision: WorkspaceRevision;
}

/** A binding's request: what a revision successor launches with, without owner-only fields. */
const bindingRequest = (
  request: StartSubagentRequest,
  handle: WorkspaceHandle,
): StartSubagentRequest => ({
  ...request,
  cwd: handle.sourceCwd,
  workspace: undefined,
  // Workflow membership and its result contract belong to the owned launch only.
  workflow: undefined,
  resultContract: undefined,
});

/** A revision successor continues the writer's task as an ordinary root-owned run. */
const successorRequest = (binding: WorkspaceBinding, message: string): StartSubagentRequest => ({
  ...binding.request,
  task: `${binding.request.task}\n\nParent revision request:\n${message}`,
  supersedes: undefined,
});

/**
 * Writer launches into private workspaces: mode selection and cheap admission before any
 * acquisition, direct-child slots for launches still acquiring workspaces, workspace binding,
 * discard of unadmitted workspaces, resume admission, and revision successors. A resume or
 * successor never changes the engine record before it is admitted; admission marks the reviewed
 * revision stale, and the next review reopens the record. A revision holds its binding until its
 * successor's launch settles, even when the revise call itself is abandoned first.
 */
export function makeWorkspaceLaunch(context: WorkspaceControlContext) {
  const { records, withLock, isClosed, state, ownerFor, requireEngine, requireBinding } = context;
  let nextLaunchSlotId = 1;
  /** Slot holds for the admission signal; releasing one can admit a waiting start. */
  const launchSlotHoldings = (): ReadonlyArray<string> =>
    [...state.launchSlots].map((slot) => `launch-slot:${slot.id}`);
  /** Under the run lock: ends a slot hold and wakes launches waiting for a slot. */
  const releaseSlotLocked = (slot: LaunchSlot) => {
    if (!state.launchSlots.delete(slot)) return;
    const released = state.slotReleased;
    state.slotReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  };
  /** Under the run lock: ends the launch slot hold a binding still records, if any. */
  const releaseBindingSlotLocked = (binding: WorkspaceBinding) => {
    const slot = binding.slot;
    binding.slot = undefined;
    if (slot) releaseSlotLocked(slot);
  };
  /**
   * Under the run lock, once admission holds a worktree launch's process slot itself: through the
   * eviction claim it takes before reclaiming history (no `admitted` record yet), or through the
   * admitted writer. The launch slot stops counting, and an admitted writer is bound to its
   * workspace. Admitting a revision's successor commits that revision: the binding takes the
   * successor's request, and the reviewed revision is stale until the next review reopens it.
   */
  const bind = (request: StartSubagentRequest, admitted?: RunRecord) => {
    if (!request.workspace) return;
    const binding = state.bindings.get(request.workspace.workspaceId);
    if (!binding) return;
    releaseBindingSlotLocked(binding);
    if (!admitted) return;
    binding.record = admitted;
    if (!binding.revision) return;
    binding.request = binding.revision.successor;
    binding.reopenPending = true;
    binding.reviewedRevision = undefined;
    binding.reviewedThrough = undefined;
  };
  /**
   * Under the run lock: direct-child slots that worktree launches still acquiring workspaces hold
   * for `caller`, other than the slot of the launch admitting `request` itself.
   */
  const heldLaunchSlots = (caller: string, request?: StartSubagentRequest): HeldLaunchSlots => {
    const own = request?.workspace
      ? state.bindings.get(request.workspace.workspaceId)?.slot
      : undefined;
    const held = [...state.launchSlots].filter((slot) => slot.caller === caller && slot !== own);
    return { total: held.length, workflow: held.filter((slot) => slot.workflow).length };
  };
  /** Under the run lock: whether the owned start that reserved `runId` holds a launch slot. */
  const launchSlotHeldBy = (runId: string): boolean =>
    [...state.launchSlots].some((slot) => slot.runId === runId);
  /** Under the run lock: the direct-child check for a worktree launch, before any acquisition. */
  const worktreeCapacityLocked = (request: StartSubagentRequest, caller: string) =>
    Effect.gen(function* () {
      const limit = (request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY).maxDirectChildren;
      // A workflow agent also leaves root slots free for the main agent, as admission checks,
      // and another workflow launch still acquiring its workspace counts as a workflow agent.
      const capacity = (held: HeldLaunchSlots) =>
        request.workflow
          ? workflowCapacityError(records, caller, limit, undefined, held)
          : processCapacityError(records, caller, limit, undefined, held.total);
      const acquiring = heldLaunchSlots(caller);
      // Admission would reject this start anyway; fail before acquiring a workspace.
      const capacityFailure = capacity({ total: 0, workflow: acquiring.workflow });
      if (capacityFailure) return yield* capacityFailure;
      // Launches still acquiring workspaces take slots at admission. Wait for one to resolve
      // rather than acquire a workspace that admission would then refuse.
      return capacity(acquiring) ? state.slotReleased : undefined;
    });
  /** Under the run lock: the writer mode a launch would use, after the cheap admission checks. */
  const checkLaunchLocked = (
    request: StartSubagentRequest,
  ): Effect.Effect<LaunchSelection, SubagentError> =>
    Effect.gen(function* () {
      if (isClosed())
        return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
      if (state.integrationQuarantined)
        return yield* invalid(
          "workspace_integration_quarantined",
          "Integration ownership is quarantined; writer admission is blocked.",
        );
      const predecessor = request.supersedes ? records.get(request.supersedes.runId) : undefined;
      const mode =
        predecessor?.view.writerWorkspaceMode ?? request.writerWorkspaceModeOverride ?? state.mode;
      if (mode !== "worktree") return { mode };
      const caller = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      if (caller !== SUBAGENT_ROOT_RUN_ID)
        return yield* invalid(
          "workspace_nested_writer_unsupported",
          "Worktree writers must be launched by the root parent. Ask the root to launch this writer; nested read-only work and shared-checkout nesting remain available.",
        );
      const slotWait = yield* worktreeCapacityLocked(request, caller);
      return slotWait ? { mode, slotWait } : { mode };
    });
  /** Selects the writer mode and reserves admission, and a worktree slot, before acquisition. */
  const selectLaunchModeLocked = (request: StartSubagentRequest, slot: LaunchSlot) =>
    checkLaunchLocked(request).pipe(
      Effect.tap((selection) =>
        Effect.sync(() => {
          if (selection.slotWait) return;
          state.reservations += 1;
          if (selection.mode === "worktree") state.launchSlots.add(slot);
        }),
      ),
    );
  /** Discards a workspace acquired for a launch that never admitted its writer. */
  const discardUnadmitted = (binding: WorkspaceBinding) => {
    const { workspaceId, ownerId } = binding.handle;
    return Effect.gen(function* () {
      const unadmitted = yield* withLock(
        Effect.sync(() => {
          // This launch will never be admitted, so its slot stops counting during the discard.
          releaseBindingSlotLocked(binding);
          return binding.record === undefined;
        }),
      );
      if (!unadmitted) return;
      const service = yield* requireEngine;
      yield* service
        .discard({ workspaceId, ownerId, processCleanupConfirmed: true })
        .pipe(Effect.mapError(mapWorkspaceError));
      yield* withLock(
        Effect.sync(() => {
          if (state.bindings.get(workspaceId) === binding) state.bindings.delete(workspaceId);
        }),
      );
    }).pipe(
      // The binding remains, so the parent can still find and discard the workspace.
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not discard an unadmitted writer workspace: ${error.message}`,
        ).pipe(Effect.annotateLogs("workspaceId", workspaceId)),
      ),
    );
  };
  /**
   * A writer launch into a worktree, or into the binding a revision successor reuses. `runId`
   * is the id an owned start reserved.
   */
  const launchWriter = (
    request: StartSubagentRequest,
    start: WorkspaceStart,
    succession?: Succession,
    runId?: string,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) => {
      const caller = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const slot: LaunchSlot = {
        caller,
        id: nextLaunchSlotId++,
        runId,
        workflow: request.workflow !== undefined,
      };
      // Only the wait for another launch's slot is interruptible; nothing is reserved during it.
      const select: Effect.Effect<WriterWorkspaceMode, SubagentError> = withLock(
        selectLaunchModeLocked(request, slot),
      ).pipe(
        Effect.flatMap(({ mode, slotWait }) =>
          slotWait
            ? restore(Deferred.await(slotWait)).pipe(Effect.andThen(Effect.suspend(() => select)))
            : Effect.succeed(mode),
        ),
      );
      return Effect.gen(function* () {
        const selectedMode = yield* select;
        let binding: WorkspaceBinding | undefined;
        let acquired = false;
        const track = (handle: WorkspaceHandle) => {
          if (binding?.handle === handle) return;
          binding = { handle, request: bindingRequest(request, handle), preparing: true, slot };
          state.bindings.set(handle.workspaceId, binding);
        };
        // The engine reports acquisition before returning, so an interrupted launch still owns
        // its workspace. That synchronous insert cannot take the run lock, which callers may
        // hold while waiting on the engine; no locked operation observes a fresh preparing binding.
        const onAcquired = (handle: WorkspaceHandle) => {
          acquired = true;
          track(handle);
        };
        /** The workspace this launch admits its writer into, acquired unless it is reused. */
        const acquireHandle = Effect.gen(function* () {
          if (succession) {
            // A revision successor keeps the reviewed binding, which only its admission updates.
            // The binding records this slot only while this launch holds the revision.
            yield* withLock(
              Effect.sync(() => {
                if (succession.binding.revision === succession.revision)
                  succession.binding.slot = slot;
              }),
            );
            return succession.binding.handle;
          }
          const service = yield* requireEngine;
          const predecessor = request.supersedes
            ? records.get(request.supersedes.runId)
            : undefined;
          const prior = predecessor?.view.workspaceId
            ? yield* withLock(requireBinding(predecessor.view.workspaceId, caller))
            : undefined;
          const acquiring = prior
            ? service.fork({
                workspaceId: prior.handle.workspaceId,
                ownerId: ownerFor(caller),
                processCleanupConfirmed: true,
                onAcquired,
              })
            : service.create({ sourceCwd: request.cwd, ownerId: ownerFor(caller), onAcquired });
          const handle = yield* restore(acquiring.pipe(Effect.mapError(mapWorkspaceError)));
          acquired = true;
          yield* withLock(Effect.sync(() => track(handle)));
          return handle;
        });
        return yield* Effect.gen(function* () {
          if (selectedMode === "shared-checkout")
            return yield* restore(
              start({ ...request, workspace: undefined, writerWorkspaceMode: selectedMode }),
            );
          const handle = yield* acquireHandle;
          return yield* restore(
            start({
              ...request,
              cwd: handle.cwd,
              workspace: handle,
              writerWorkspaceMode: selectedMode,
            }),
          );
        }).pipe(
          Effect.onError(() => (acquired && binding ? discardUnadmitted(binding) : Effect.void)),
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                state.reservations -= 1;
                releaseSlotLocked(slot);
                const holder = binding ?? succession?.binding;
                if (holder?.slot === slot) holder.slot = undefined;
                if (binding) binding.preparing = false;
              }),
            ),
          ),
        );
      });
    });
  /**
   * Hands a revision's hold to the launch of the successor it reserved. This runs as that
   * launch's first step, outside the run lock, so the hold changes hands before an abandoned
   * revise call can release it; no locked section reads `launched` across a suspension.
   */
  const claimRevision = (
    request: StartSubagentRequest,
    reuse: WorkspaceHandle,
  ): Succession | undefined => {
    const binding = state.bindings.get(reuse.workspaceId);
    const revision = binding?.handle === reuse ? binding.revision : undefined;
    if (!binding || !revision || revision.successor !== request || revision.launched)
      return undefined;
    revision.launched = true;
    return { binding, revision };
  };
  /** Under the run lock: ends a revision's hold on its binding. */
  const releaseRevisionLocked = ({ binding, revision }: Succession) => {
    if (binding.revision !== revision) return;
    binding.revision = undefined;
    binding.preparing = false;
  };
  /**
   * A revision successor's launch, which holds its revision from its first step until it
   * settles. Its admission commits the revision; a refusal leaves the binding, its request and
   * its reviewed revision untouched.
   */
  const launchSuccessor = (
    request: StartSubagentRequest,
    start: WorkspaceStart,
    reuse: WorkspaceHandle,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const succession = claimRevision(request, reuse);
        if (!succession)
          return Effect.fail(
            invalid(
              "workspace_owner_unavailable",
              "The revision that requested this successor no longer holds its workspace.",
            ),
          );
        return restore(launchWriter(request, start, succession)).pipe(
          Effect.ensuring(withLock(Effect.sync(() => releaseRevisionLocked(succession)))),
        );
      }),
    );
  const withLaunch = (
    request: StartSubagentRequest,
    start: WorkspaceStart,
    options: LaunchOptions = {},
  ): Effect.Effect<SubagentRunView, SubagentError> => {
    if (request.writeIntent !== "writer")
      return start({ ...request, workspace: undefined, writerWorkspaceMode: undefined });
    return options.reuse
      ? launchSuccessor(request, start, options.reuse)
      : launchWriter(request, start, undefined, options.runId);
  };
  /**
   * Called under the run lock with every other resume check, at the claim. Refuses a writer that
   * no longer owns its workspace, and returns the commit that marks the reviewed revision stale
   * as the claim completes. A refused resume never changes the workspace.
   */
  const invalidateForResume = (record: RunRecord): Effect.Effect<() => void, SubagentError> =>
    Effect.gen(function* () {
      if (!record.view.workspaceId) return () => {};
      const binding = state.bindings.get(record.view.workspaceId);
      if (!binding || binding.record !== record || binding.preparing)
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace resume ownership is unavailable or belongs to a revision successor.",
        );
      if (binding.busy !== undefined) return yield* workspaceBusyError();
      if (binding.finished) return yield* workspaceFinishedError();
      // A live paused process keeps review refused, so its workspace is still active with no
      // revision or preparation to invalidate. It resumes in place.
      if (record.process !== undefined) return () => {};
      return () => {
        binding.reopenPending = true;
        binding.reviewedRevision = undefined;
        binding.reviewedThrough = undefined;
      };
    });
  const revise =
    (
      start: (request: StartSubagentRequest, reuse: WorkspaceHandle) => ReturnType<WorkspaceStart>,
    ) =>
    (
      workspaceId: string,
      message: string,
      caller = SUBAGENT_ROOT_RUN_ID,
    ): Effect.Effect<SubagentRunView, SubagentError> =>
      Effect.uninterruptibleMask((restore) => {
        let held: Succession | undefined;
        return Effect.gen(function* () {
          if (!message.trim())
            return yield* invalid("message_required", "A revision request is required.");
          const reserved = yield* restore(
            context.operations.withPermits(1)(
              withLock(
                Effect.gen(function* () {
                  const binding = yield* requireBinding(workspaceId, caller);
                  if (binding.finished) return yield* workspaceFinishedError();
                  const revision: WorkspaceRevision = {
                    successor: successorRequest(binding, message),
                    launched: false,
                  };
                  // Refuse early a successor that admission would reject. Slots held by launches
                  // still acquiring workspaces are left to the successor's launch, which waits.
                  yield* checkLaunchLocked(revision.successor);
                  binding.preparing = true;
                  binding.revision = revision;
                  held = { binding, revision };
                  return held;
                }),
              ),
            ),
          );
          return yield* restore(start(reserved.revision.successor, reserved.binding.handle));
        }).pipe(
          // Once the successor's launch has started, it holds the revision until it settles.
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                if (held && !held.revision.launched) releaseRevisionLocked(held);
              }),
            ),
          ),
        );
      });
  return {
    bind,
    heldLaunchSlots,
    launchSlotHeldBy,
    launchSlotHoldings,
    withLaunch,
    invalidateForResume,
    revise,
  };
}
