import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  type WriterWorkspaceMode,
} from "../config/schema.ts";
import type {
  WorkspaceHandle,
  WorkspaceLaunch,
  WorkspaceRebase,
  WorkspaceTarget,
} from "../workspace/model.ts";
import { processCapacityError, treeCapacityError } from "./admission.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import {
  isActiveRunState,
  SUBAGENT_ROOT_RUN_ID,
  type StartSubagentRequest,
  type SubagentRunView,
} from "./model.ts";
import { runSessionOwned } from "./session-owned.ts";
import { runWorktreeCreateHooks } from "./workspace-hooks.ts";
import {
  bindingSlot,
  clearBindingSlot,
  isBindingFinished,
  type LaunchSlot,
  mapWorkspaceError,
  reopenBindingLocked,
  requireHooksSettled,
  type RevisionHold,
  runHoldsCwd,
  runsWithin,
  type SharedReservation,
  UNREVIEWED,
  type WorkspaceBinding,
  type WorkspaceControlContext,
  workspaceBusyError,
  workspaceFinishedError,
} from "./workspace-binding.ts";

type WorkspaceStart = (
  request: StartSubagentRequest,
) => Effect.Effect<SubagentRunView, SubagentError>;

export interface WorkspaceReviseOptions {
  /** Rebuild the worker from current parent files and reapply its changes before the pass. */
  readonly rebase?: boolean | undefined;
  /**
   * Resolves an adopted orphan's recorded launch into a new writer request with `task`, the way
   * a start item naming that launch would; required to revise a workspace this session adopted.
   */
  readonly resolveLaunch?:
    | ((
        launch: WorkspaceLaunch,
        task: string,
      ) => Effect.Effect<StartSubagentRequest, SubagentError>)
    | undefined;
}

export interface WorkspaceRevised {
  readonly run: SubagentRunView;
  /** Present when the successor's worker tree was rebuilt; it lists the conflicted files. */
  readonly rebase?: WorkspaceRebase | undefined;
}

interface LaunchSelection {
  readonly mode: WriterWorkspaceMode;
  /** The nested caller's own workspace, whose worker tree is the new workspace's source. */
  readonly sourceWorkspace?: WorkspaceTarget | undefined;
  readonly slotWait?: Deferred.Deferred<void>;
}

interface Succession {
  readonly binding: WorkspaceBinding;
  readonly revision: RevisionHold;
}

// Pinning the mode keeps revision successors in this workspace after the session default changes.
const bindingRequest = (
  request: StartSubagentRequest,
  handle: WorkspaceHandle,
  mode: WriterWorkspaceMode,
): StartSubagentRequest => ({
  ...request,
  cwd: handle.sourceCwd,
  workspace: undefined,
  writerWorkspaceModeOverride: mode,
});

const successorRequest = (
  request: StartSubagentRequest,
  message: string,
): StartSubagentRequest => ({
  ...request,
  task: `${request.task}\n\nParent revision request:\n${message}`,
});

/** An adopted workspace's first successor: a new run with the parent's message as its task. */
const adoptedSuccessor = (
  resolved: StartSubagentRequest,
  binding: WorkspaceBinding,
  message: string,
): StartSubagentRequest => ({
  ...bindingRequest(resolved, binding.handle, "worktree"),
  task: message,
});

const launchFacts = (request: StartSubagentRequest): WorkspaceLaunch => ({
  ...(request.profile !== undefined && { profile: request.profile }),
  ...(request.agent !== undefined && { agent: request.agent }),
  ...(request.name !== undefined && { name: request.name }),
});

const MAX_PROMPT_CONFLICTS = 50;

/** The successor's task names the rebase and every file it must resolve first. */
const rebasedSuccessor = (
  request: StartSubagentRequest,
  { conflictedPaths }: WorkspaceRebase,
): StartSubagentRequest => {
  const listed = conflictedPaths
    .slice(0, MAX_PROMPT_CONFLICTS)
    .map((name) => `- ${JSON.stringify(name.slice(0, 256))}`);
  const more =
    conflictedPaths.length > MAX_PROMPT_CONFLICTS
      ? [
          `- and ${conflictedPaths.length - MAX_PROMPT_CONFLICTS} more; search the workspace for <<<<<<< to find them`,
        ]
      : [];
  const note =
    conflictedPaths.length === 0
      ? "Your workspace was rebuilt from the parent's current files, and your previous changes reapplied cleanly with a three-way merge. Check that they still fit the parent's changes."
      : [
          `Your workspace was rebuilt from the parent's current files, and your previous changes were reapplied with a three-way merge. These ${conflictedPaths.length === 1 ? "file has" : `${conflictedPaths.length} files have`} conflicts; resolve them before anything else:`,
          ...listed,
          ...more,
          "In each text file, replace every block from <<<<<<< through >>>>>>> with content that keeps both the parent's change (ours) and yours (theirs), and leave no markers. A conflicted binary file holds the parent's version; redo your change to it.",
        ].join("\n");
  return { ...request, task: `${request.task}\n\nParent rebase:\n${note}` };
};

const workspaceOwnerChanged = () =>
  invalid(
    "workspace_owner_unavailable",
    "Workspace ownership changed while its revision was being prepared. Retry the revision.",
  );

const integrationQuarantinedError = () =>
  invalid(
    "workspace_integration_quarantined",
    "Integration ownership is quarantined; writer admission is blocked.",
  );

const holdsRevision = ({ binding, revision }: Succession) =>
  binding.state.phase === "revising" && binding.state.hold === revision;

const releaseRevisionLocked = ({ binding, revision }: Succession) => {
  const { state } = binding;
  if (state.phase === "revising" && state.hold === revision)
    binding.state = { phase: "idle", knowledge: state.knowledge };
};

export function workspaceLaunchOperations(context: WorkspaceControlContext) {
  const { records, withLock, isClosed, state, ownerFor, requireEngine, requireBinding } = context;
  const { engine } = context;
  const { worktreeCreate, requireChildrenResolved } = context;
  const { operations, ownerScope } = context;
  const releaseSlotLocked = (slot: LaunchSlot | undefined) => {
    if (!slot || !state.launchSlots.delete(slot)) return;
    const released = state.slotReleased;
    state.slotReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  };
  const releaseBindingSlotLocked = (binding: WorkspaceBinding) => {
    const slot = bindingSlot(binding);
    clearBindingSlot(binding);
    releaseSlotLocked(slot);
  };
  /** Admission settles a new workspace, or commits a revision to its successor. */
  const bind = (request: StartSubagentRequest, admitted?: RunRecord) => {
    if (!request.workspace) return;
    const binding = state.bindings.get(request.workspace.workspaceId);
    if (!binding) return;
    releaseBindingSlotLocked(binding);
    if (!admitted) return;
    binding.record = admitted;
    const { state: current } = binding;
    if (current.phase === "creating") binding.state = UNREVIEWED;
    if (current.phase !== "revising") return;
    binding.request = current.hold.successor;
    reopenBindingLocked(binding);
  };
  /** Counts slots held by worktree launches still creating workspaces; omit caller for the tree. */
  const heldLaunchSlots = (caller?: string, request?: StartSubagentRequest): number => {
    const binding = request?.workspace && state.bindings.get(request.workspace.workspaceId);
    const own = binding ? bindingSlot(binding) : undefined;
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
  /**
   * The binding of an active Pi worktree writer that may own worktree writer children, judged
   * only from the authenticated caller's own run record and launch facts.
   */
  const workspaceParentLocked = (caller: string): WorkspaceBinding | undefined => {
    const record = records.get(caller);
    if (!record || isInactiveRunRecord(record) || !isActiveRunState(record.view.state))
      return undefined;
    const { view } = record;
    if (
      view.runtime !== "pi" ||
      view.writeIntent !== "writer" ||
      view.writerWorkspaceMode !== "worktree" ||
      view.workspaceId === undefined ||
      record.launch.workspaceParent !== true
    )
      return undefined;
    const binding = state.bindings.get(view.workspaceId);
    return binding?.record === record && !isBindingFinished(binding) ? binding : undefined;
  };
  const checkLaunchLocked = (
    request: StartSubagentRequest,
  ): Effect.Effect<LaunchSelection, SubagentError> =>
    Effect.gen(function* () {
      if (isClosed())
        return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
      if (state.integrationQuarantined) return yield* integrationQuarantinedError();
      const caller = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const parent = caller === SUBAGENT_ROOT_RUN_ID ? undefined : workspaceParentLocked(caller);
      // The start item's isolation wins, and a worktree writer's own writers default to worktrees.
      const mode = request.writerWorkspaceModeOverride ?? (parent ? "worktree" : state.mode);
      if (mode !== "worktree") return { mode };
      if (caller !== SUBAGENT_ROOT_RUN_ID && !parent)
        return yield* invalid(
          "workspace_nested_writer_unsupported",
          "Only the root parent or an active worktree writer may start worktree writers. Ask the root to launch this writer; nested read-only work and shared-checkout nesting remain available.",
        );
      const sourceWorkspace = parent && {
        workspaceId: parent.handle.workspaceId,
        ownerId: parent.handle.ownerId,
      };
      const slotWait = yield* worktreeCapacityLocked(request, caller);
      return { mode, sourceWorkspace, ...(slotWait && { slotWait }) };
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
      // The engine refuses a workspace whose hook cleanup is unconfirmed, which then stays.
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
      const reservation: SharedReservation = { cwd: request.cwd, caller };
      const select: Effect.Effect<Omit<LaunchSelection, "slotWait">, SubagentError> = withLock(
        checkLaunchLocked(request).pipe(
          Effect.tap(({ mode, slotWait }) =>
            Effect.sync(() => {
              if (slotWait) return;
              if (mode === "worktree") state.launchSlots.add(slot);
              else state.sharedReservations.add(reservation);
            }),
          ),
        ),
      ).pipe(
        Effect.flatMap(({ mode, sourceWorkspace, slotWait }) =>
          slotWait
            ? restore(Deferred.await(slotWait)).pipe(Effect.andThen(() => select))
            : Effect.succeed({ mode, sourceWorkspace }),
        ),
      );
      return Effect.gen(function* () {
        const { mode: selectedMode, sourceWorkspace } = yield* select;
        let binding: WorkspaceBinding | undefined;
        const onAcquired = (handle: WorkspaceHandle) => {
          if (binding?.handle === handle) return;
          binding = {
            handle,
            request: bindingRequest(request, handle, selectedMode),
            state: { phase: "creating", slot },
          };
          state.bindings.set(handle.workspaceId, binding);
        };
        const acquireHandle = Effect.gen(function* () {
          if (succession) {
            yield* withLock(
              Effect.sync(() => {
                const { state: current } = succession.binding;
                if (current.phase === "revising" && current.hold === succession.revision)
                  succession.binding.state = { ...current, slot };
              }),
            );
            return succession.binding.handle;
          }
          const service = yield* requireEngine;
          const handle = yield* restore(
            service
              .create({
                sourceCwd: request.cwd,
                ownerId: ownerFor(caller),
                sourceWorkspace,
                launch: launchFacts(request),
                onAcquired,
              })
              .pipe(Effect.mapError(mapWorkspaceError)),
          );
          yield* withLock(Effect.sync(() => onAcquired(handle)));
          yield* restore(runWorktreeCreateHooks(service, worktreeCreate, handle, {}));
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
                state.sharedReservations.delete(reservation);
                releaseSlotLocked(slot);
                const holder = binding ?? succession?.binding;
                if (holder && bindingSlot(holder) === slot) clearBindingSlot(holder);
                // An unadmitted workspace whose discard failed stays for the parent to discard.
                if (binding?.state.phase === "creating") binding.state = UNREVIEWED;
              }),
            ),
          ),
        );
      });
    });
  /**
   * Rebuilds the held workspace's worker tree from current parent files and runs the
   * WorktreeCreate hooks there like a new launch. Once the tree changed, no earlier review or
   * preparation describes it, even if the hooks or the successor's admission then fail.
   */
  const rebaseHeld = (held: Succession): Effect.Effect<WorkspaceRebase, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      const { binding } = held;
      const { workspaceId, ownerId } = binding.handle;
      yield* withLock(
        Effect.gen(function* () {
          if (!holdsRevision(held))
            return yield* invalid(
              "workspace_owner_unavailable",
              "The revision that requested this rebase no longer holds its workspace.",
            );
          // A rebase removes and rewrites the worker's files, like discard removes them.
          if ([...runsWithin(records, [binding.handle.artifactRoot]).keys()].some(runHoldsCwd))
            return yield* invalid(
              "workspace_process_unsettled",
              "A run still uses this workspace's tree. Stop it and confirm cleanup before a rebase rebuilds the tree.",
            );
          return undefined;
        }),
      );
      const rebased = yield* service
        .rebase({ workspaceId, ownerId, processCleanupConfirmed: true })
        .pipe(Effect.mapError(mapWorkspaceError));
      yield* withLock(
        Effect.sync(() => {
          const { state: current } = binding;
          if (current.phase === "revising" && current.hold === held.revision)
            binding.state = { ...current, knowledge: { kind: "unreviewed" } };
        }),
      );
      yield* runWorktreeCreateHooks(service, worktreeCreate, binding.handle, {
        runId: binding.record?.view.id,
      });
      return rebased;
    });
  const launchSuccessor = (
    held: Succession,
    start: WorkspaceStart,
  ): Effect.Effect<WorkspaceRevised, SubagentError> =>
    Effect.uninterruptibleMask((restore) => {
      if (!holdsRevision(held) || held.revision.launched)
        return Effect.fail(
          invalid(
            "workspace_owner_unavailable",
            "The revision that requested this successor no longer holds its workspace.",
          ),
        );
      held.revision.launched = true;
      return Effect.gen(function* () {
        const { successor } = held.revision;
        if (!held.revision.rebase)
          return { run: yield* restore(launchWriter(successor, start, held)) };
        const rebase = yield* restore(rebaseHeld(held));
        // The note goes to this successor only; later revisions extend the plain request.
        const run = yield* restore(launchWriter(rebasedSuccessor(successor, rebase), start, held));
        return { run, rebase };
      }).pipe(Effect.ensuring(withLock(Effect.sync(() => releaseRevisionLocked(held)))));
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
      const phase = binding?.state.phase;
      if (!binding || binding.record !== record || phase === "creating" || phase === "revising")
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace resume ownership is unavailable or belongs to a revision successor.",
        );
      if (phase === "busy") return yield* workspaceBusyError();
      if (isBindingFinished(binding)) return yield* workspaceFinishedError(binding);
      if (state.integrationQuarantined) return yield* integrationQuarantinedError();
      yield* requireHooksSettled(
        engine,
        binding,
        "Worktree hook cleanup is unconfirmed; this artifact requires manual recovery.",
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
      options: WorkspaceReviseOptions = {},
    ): Effect.Effect<WorkspaceRevised, SubagentError> => {
      const resolveAdopted = (launch: WorkspaceLaunch, task: string) =>
        Effect.gen(function* () {
          const { resolveLaunch } = options;
          if (!resolveLaunch)
            return yield* invalid(
              "workspace_launch_unavailable",
              "This adopted workspace has no writer request to extend; revise it through agent_worktree.",
            );
          const resolved = yield* resolveLaunch(launch, task);
          if (resolved.writeIntent !== "writer")
            return yield* invalid(
              "workspace_launch_unavailable",
              `The recorded launch profile ${resolved.profile ?? "generalist"} no longer starts writers. Apply or discard this workspace, or start a new writer.`,
            );
          return resolved;
        });
      return Effect.uninterruptibleMask((restore) => {
        let held: Succession | undefined;
        return Effect.gen(function* () {
          if (!message.trim())
            return yield* invalid("message_required", "A revision request is required.");
          const reserved = yield* restore(
            operations.withPermits(1)(
              Effect.gen(function* () {
                // An adopted workspace's successor is resolved from its recorded launch first,
                // outside the run lock; the binding is rechecked under it.
                const adopted = yield* withLock(
                  Effect.sync(() => {
                    const binding = state.bindings.get(workspaceId);
                    return binding && binding.request === undefined
                      ? (binding.launch ?? {})
                      : undefined;
                  }),
                );
                const resolved =
                  adopted === undefined ? undefined : yield* resolveAdopted(adopted, message);
                return yield* withLock(
                  Effect.gen(function* () {
                    const binding = yield* requireBinding(workspaceId, caller);
                    const { state: current } = binding;
                    if (current.phase !== "idle") return yield* workspaceFinishedError();
                    yield* requireChildrenResolved(binding);
                    const successor = binding.request
                      ? successorRequest(binding.request, message)
                      : resolved && adoptedSuccessor(resolved, binding, message);
                    if (!successor) return yield* workspaceOwnerChanged();
                    const revision: RevisionHold = {
                      successor,
                      rebase: options.rebase === true,
                      launched: false,
                    };
                    yield* checkLaunchLocked(revision.successor);
                    binding.state = {
                      phase: "revising",
                      hold: revision,
                      slot: undefined,
                      knowledge: current.knowledge,
                    };
                    held = { binding, revision };
                    return held;
                  }),
                );
              }),
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
    };
  return { bind, heldLaunchSlots, withLaunch, invalidateForResume, revise };
}
