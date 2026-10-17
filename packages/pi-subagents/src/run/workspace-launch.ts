import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  type WriterWorkspaceMode,
} from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import { processCapacityError, treeCapacityError } from "./admission.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID, type StartSubagentRequest, type SubagentRunView } from "./model.ts";
import { runSessionOwned } from "./session-owned.ts";
import { provisionWorkspaceTree } from "./workspace-setup.ts";
import {
  type LaunchSlot,
  mapWorkspaceError,
  reopenBindingLocked,
  type RevisionHold,
  type WorkspaceBinding,
  type WorkspaceControlContext,
  workspaceBusyError,
  workspaceFinishedError,
} from "./workspace-binding.ts";

type WorkspaceStart = (
  request: StartSubagentRequest,
) => Effect.Effect<SubagentRunView, SubagentError>;

interface LaunchSelection {
  readonly mode: WriterWorkspaceMode;
  readonly slotWait?: Deferred.Deferred<void>;
}

interface Succession {
  readonly binding: WorkspaceBinding;
  readonly revision: RevisionHold;
}

const bindingRequest = (
  request: StartSubagentRequest,
  handle: WorkspaceHandle,
): StartSubagentRequest => ({
  ...request,
  cwd: handle.sourceCwd,
  workspace: undefined,
});

const successorRequest = (binding: WorkspaceBinding, message: string): StartSubagentRequest => ({
  ...binding.request,
  task: `${binding.request.task}\n\nParent revision request:\n${message}`,
  supersedes: undefined,
});

const integrationQuarantinedError = () =>
  invalid(
    "workspace_integration_quarantined",
    "Integration ownership is quarantined; writer admission is blocked.",
  );

const releaseRevisionLocked = ({ binding, revision }: Succession) => {
  if (binding.revision !== revision) return;
  binding.revision = undefined;
  binding.preparing = false;
};

export function workspaceLaunchOperations(context: WorkspaceControlContext) {
  const { records, withLock, isClosed, state, ownerFor, requireEngine, requireBinding } = context;
  const { workspaceSetup } = context;
  const { operations, ownerScope } = context;
  const releaseSlotLocked = (slot: LaunchSlot | undefined) => {
    if (!slot || !state.launchSlots.delete(slot)) return;
    const released = state.slotReleased;
    state.slotReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  };
  const releaseBindingSlotLocked = (binding: WorkspaceBinding) => {
    const slot = binding.slot;
    binding.slot = undefined;
    releaseSlotLocked(slot);
  };
  const bind = (request: StartSubagentRequest, admitted?: RunRecord) => {
    if (!request.workspace) return;
    const binding = state.bindings.get(request.workspace.workspaceId);
    if (!binding) return;
    releaseBindingSlotLocked(binding);
    if (!admitted) return;
    binding.record = admitted;
    if (!binding.revision) return;
    binding.request = binding.revision.successor;
    reopenBindingLocked(binding);
  };
  /** Counts slots held by worktree launches still creating workspaces; omit caller for the tree. */
  const heldLaunchSlots = (caller?: string, request?: StartSubagentRequest): number => {
    const own = request?.workspace
      ? state.bindings.get(request.workspace.workspaceId)?.slot
      : undefined;
    return [...state.launchSlots].filter(
      (slot) => slot !== own && (caller === undefined || slot.caller === caller),
    ).length;
  };
  const worktreeCapacityLocked = (request: StartSubagentRequest, caller: string) =>
    Effect.gen(function* () {
      const nesting = request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY;
      const direct = nesting.maxDirectChildren;
      const tree = nesting.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS;
      const capacityFailure =
        processCapacityError(records, caller, direct) ?? treeCapacityError(records, tree);
      if (capacityFailure) return yield* capacityFailure;
      // Only launches still creating workspaces fill the limit, so wait for one to resolve.
      return (processCapacityError(records, caller, direct, undefined, heldLaunchSlots(caller)) ??
        treeCapacityError(records, tree, undefined, heldLaunchSlots()))
        ? state.slotReleased
        : undefined;
    });
  /** A route retry forks only from the failed writer that still owns an unfinished workspace. */
  const holdForkSourceLocked = (predecessor: RunRecord, workspaceId: string, caller: string) =>
    Effect.gen(function* () {
      const current = state.bindings.get(workspaceId);
      if (current?.finished) return yield* workspaceFinishedError();
      if (current && current.record !== predecessor)
        return yield* invalid(
          "workspace_owner_unavailable",
          "A revision successor now owns this workspace, so the failed writer's retry cannot fork from it.",
        );
      const binding = yield* requireBinding(workspaceId, caller);
      const token = Symbol("workspace fork");
      binding.busy = token;
      return { binding, token };
    });
  const checkLaunchLocked = (
    request: StartSubagentRequest,
  ): Effect.Effect<LaunchSelection, SubagentError> =>
    Effect.gen(function* () {
      if (isClosed())
        return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
      if (state.integrationQuarantined) return yield* integrationQuarantinedError();
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
  const discardUnadmitted = (binding: WorkspaceBinding) => {
    const { workspaceId, ownerId } = binding.handle;
    return Effect.gen(function* () {
      const unadmitted = yield* withLock(
        Effect.sync(() => {
          releaseBindingSlotLocked(binding);
          return binding.record === undefined;
        }),
      );
      if (!unadmitted || binding.setupCleanupPending) return;
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
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not discard an unadmitted writer workspace: ${error.message}`,
        ).pipe(Effect.annotateLogs("workspaceId", workspaceId)),
      ),
    );
  };
  const launchWriter = (
    request: StartSubagentRequest,
    start: WorkspaceStart,
    succession?: Succession,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) => {
      const caller = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const slot: LaunchSlot = { caller };
      const select: Effect.Effect<WriterWorkspaceMode, SubagentError> = withLock(
        checkLaunchLocked(request).pipe(
          Effect.tap(({ mode, slotWait }) =>
            Effect.sync(() => {
              if (slotWait) return;
              state.reservations += 1;
              if (mode === "worktree" && slot) state.launchSlots.add(slot);
            }),
          ),
        ),
      ).pipe(
        Effect.flatMap(({ mode, slotWait }) =>
          slotWait
            ? restore(Deferred.await(slotWait)).pipe(Effect.andThen(() => select))
            : Effect.succeed(mode),
        ),
      );
      return Effect.gen(function* () {
        const selectedMode = yield* select;
        let binding: WorkspaceBinding | undefined;
        const onAcquired = (handle: WorkspaceHandle) => {
          if (binding?.handle === handle) return;
          binding = { handle, request: bindingRequest(request, handle), preparing: true, slot };
          state.bindings.set(handle.workspaceId, binding);
        };
        const acquireHandle = Effect.gen(function* () {
          if (succession) {
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
            ? yield* withLock(
                holdForkSourceLocked(predecessor, predecessor.view.workspaceId, caller),
              )
            : undefined;
          const acquiring = prior
            ? service
                .fork({
                  workspaceId: prior.binding.handle.workspaceId,
                  ownerId: ownerFor(caller),
                  processCleanupConfirmed: true,
                  onAcquired,
                })
                .pipe(
                  Effect.ensuring(
                    withLock(
                      Effect.sync(() => {
                        if (prior.binding.busy === prior.token) prior.binding.busy = undefined;
                      }),
                    ),
                  ),
                )
            : service.create({ sourceCwd: request.cwd, ownerId: ownerFor(caller), onAcquired });
          const handle = yield* restore(acquiring.pipe(Effect.mapError(mapWorkspaceError)));
          yield* withLock(Effect.sync(() => onAcquired(handle)));
          if (workspaceSetup)
            yield* restore(
              provisionWorkspaceTree(service, workspaceSetup, handle, {}, (pending) => {
                if (binding) binding.setupCleanupPending = pending;
              }),
            );
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
          Effect.onError(() => (binding ? discardUnadmitted(binding) : Effect.void)),
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                state.reservations -= 1;
                releaseSlotLocked(slot);
                const holder = binding ?? succession?.binding;
                if (slot && holder?.slot === slot) holder.slot = undefined;
                if (binding) binding.preparing = false;
              }),
            ),
          ),
        );
      });
    });
  const launchSuccessor = (
    held: Succession,
    start: WorkspaceStart,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) => {
      if (held.binding.revision !== held.revision || held.revision.launched)
        return Effect.fail(
          invalid(
            "workspace_owner_unavailable",
            "The revision that requested this successor no longer holds its workspace.",
          ),
        );
      held.revision.launched = true;
      return restore(launchWriter(held.revision.successor, start, held)).pipe(
        Effect.ensuring(withLock(Effect.sync(() => releaseRevisionLocked(held)))),
      );
    });
  const withLaunch = (
    request: StartSubagentRequest,
    start: WorkspaceStart,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    request.writeIntent === "writer"
      ? launchWriter(request, start)
      : start({ ...request, workspace: undefined, writerWorkspaceMode: undefined });
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
      if (state.integrationQuarantined) return yield* integrationQuarantinedError();
      if (binding.setupCleanupPending)
        return yield* invalid(
          "workspace_process_unsettled",
          "Workspace setup cleanup is unconfirmed; this artifact requires manual recovery.",
        );
      if (record.process !== undefined) return () => {};
      return () => reopenBindingLocked(binding);
    });
  const revise =
    (start: WorkspaceStart) =>
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
            operations.withPermits(1)(
              withLock(
                Effect.gen(function* () {
                  const binding = yield* requireBinding(workspaceId, caller);
                  if (binding.finished) return yield* workspaceFinishedError();
                  const revision: RevisionHold = {
                    successor: successorRequest(binding, message),
                    launched: false,
                  };
                  yield* checkLaunchLocked(revision.successor);
                  binding.preparing = true;
                  binding.revision = revision;
                  held = { binding, revision };
                  return held;
                }),
              ),
            ),
          );
          return yield* restore(
            runSessionOwned(ownerScope, Effect.void, () => launchSuccessor(reserved, start)),
          );
        }).pipe(
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                if (held && !held.revision.launched) releaseRevisionLocked(held);
              }),
            ),
          ),
        );
      });
  return { bind, heldLaunchSlots, withLaunch, invalidateForResume, revise };
}
