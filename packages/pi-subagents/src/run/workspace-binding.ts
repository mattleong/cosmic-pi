import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { isActiveRunState, type StartSubagentRequest, type SubagentRunView } from "./model.ts";

export interface LaunchSlot {
  readonly caller: string;
}

export interface RevisionHold {
  readonly successor: StartSubagentRequest;
  launched: boolean;
}

export interface WorkspaceBinding {
  readonly handle: WorkspaceHandle;
  request: StartSubagentRequest;
  record?: RunRecord;
  preparing: boolean;
  busy?: symbol | undefined;
  reopenPending?: boolean | undefined;
  reviewedRevision?: string | undefined;
  reviewedThrough?: number | undefined;
  finished?: boolean | undefined;
  integrated?: boolean | undefined;
  slot?: LaunchSlot | undefined;
  revision?: RevisionHold | undefined;
}

export type WorkspaceControlDependencies = Pick<
  RunContext,
  "ownerScope" | "records" | "withLock" | "writerLeases"
> & {
  readonly writerPools: { readonly size: number };
  readonly engine: WorkspaceServiceContract | undefined;
  readonly initialMode: WriterWorkspaceMode;
  readonly ownerId: string;
  readonly sourceCwd?: string;
  readonly isClosed: () => boolean;
};

interface WorkspaceControlState {
  mode: WriterWorkspaceMode;
  reservations: number;
  integrationQuarantined: boolean;
  readonly bindings: Map<string, WorkspaceBinding>;
  readonly launchSlots: Set<LaunchSlot>;
  slotReleased: Deferred.Deferred<void>;
}

export interface WorkspaceControlContext extends WorkspaceControlDependencies {
  readonly state: WorkspaceControlState;
  readonly ownerFor: (caller: string) => string;
  readonly requireEngine: Effect.Effect<WorkspaceServiceContract, SubagentError>;
  readonly requireBinding: (
    workspaceId: string,
    caller: string,
  ) => Effect.Effect<WorkspaceBinding, SubagentError>;
  readonly operations: Semaphore.Semaphore;
}

export const mapWorkspaceError = (error: { readonly message: string }) =>
  invalid("workspace_operation_failed", error.message);

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
    [...records.values()]
      .filter(
        (record) => record !== except && trees.some((tree) => isWithin(record.view.cwd, tree)),
      )
      .map((record) => [record, record.view]),
  );

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
  return {
    ...dependencies,
    state,
    ownerFor,
    requireEngine,
    requireBinding,
    operations: Semaphore.makeUnsafe(1),
  };
}
