import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { claimCompletion, completionClaimOwner, releaseCompletionClaim } from "./completion.ts";
import {
  invalidRequest,
  type InvalidSubagentRequestError,
  type SubagentError,
  type SubagentRuntimeClosedError,
  type SubagentWriterConflictError,
} from "./errors.ts";
import type { RunContext, RunOwnership, RunRecord } from "./internal.ts";
import {
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentRunView,
  type SubagentUsage,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { WorkspaceBindingStatus } from "./workspace-binding.ts";

export interface OwnedRunHandle {
  readonly runId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly claimToken: string;
}

interface OwnedRunSpend {
  readonly usage: SubagentUsage;
  readonly toolUses: number;
}

export type OwnedRunOutcome = OwnedRunSpend &
  (
    | {
        readonly kind: "completed";
        readonly text: string;
        readonly warning?: string | undefined;
      }
    | {
        readonly kind: "failed" | "stopped";
        readonly reason: string;
      }
  );

export interface OwnedRunStart {
  readonly ownerId: string;
  readonly runId?: string | undefined;
}

export interface OwnedRunCoordinatorContract {
  readonly reserveRunId: Effect.Effect<string>;
  readonly openOwner: (ownerId: string) => Effect.Effect<void>;
  readonly startOwned: (
    request: StartSubagentRequest,
    owner: OwnedRunStart,
  ) => Effect.Effect<OwnedRunHandle, SubagentError, Scope.Scope>;
  readonly awaitOwned: (
    handle: OwnedRunHandle,
  ) => Effect.Effect<OwnedRunOutcome, InvalidSubagentRequestError | SubagentRuntimeClosedError>;
  readonly closeOwner: (ownerId: string) => Effect.Effect<void>;
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  readonly admissionRevision: Effect.Effect<number>;
  readonly waitForAdmissionChange: (
    after: number,
  ) => Effect.Effect<void, SubagentRuntimeClosedError>;
  readonly queuedWriterConflict: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentWriterConflictError | undefined>;
  readonly workspaceBindingStatus: (workspaceId: string) => Effect.Effect<WorkspaceBindingStatus>;
}

export interface RunOwnedRunsDependencies extends Pick<RunContext, "records" | "withLock"> {
  readonly allocateClaimToken: () => string;
  readonly isAllocatedRunId: (id: string) => boolean;
  readonly currentRevision: () => number;
  readonly waitForRevision: OwnedRunCoordinatorContract["waitForRevision"];
  readonly delivery: Pick<RunNotificationDelivery, "wakeCompletionLocked">;
  readonly start: (
    request: StartSubagentRequest,
    ownership: RunOwnership,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
}

interface OwnerEntry {
  open: boolean;
  readonly runIds: Set<string>;
}

type AwaitStep = { readonly outcome: OwnedRunOutcome } | { readonly revision: number };

const STOPPED_REASON = "Stopped before reporting.";

const consumeLocked = (record: RunRecord, handle: OwnedRunHandle): void => {
  record.completionGenerations.delete(handle.generation);
  record.completionClaims.delete(handle.generation);
};

const relinquishLocked = (record: RunRecord): void => {
  if (!record.owner?.live) return;
  record.owner.live = false;
  const { resultContract: _contract, ...launch } = record.launch;
  record.launch = {
    ...launch,
    ...(record.releasedSystemPrompt !== undefined && {
      systemPrompt: record.releasedSystemPrompt,
    }),
  };
};

const isLive = (record: RunRecord): boolean =>
  !record.stoppedByParent && !isTerminalRunState(record.view.state);

export function makeRunOwnedRuns(dependencies: RunOwnedRunsDependencies) {
  const {
    records,
    withLock,
    allocateClaimToken,
    isAllocatedRunId,
    currentRevision,
    waitForRevision,
    delivery,
    start,
    stop,
  } = dependencies;
  const owners = new Map<string, OwnerEntry>();

  const checkOwnerLocked = (owner: OwnedRunStart) =>
    Effect.gen(function* () {
      if (owners.get(owner.ownerId)?.open !== true)
        return yield* invalidRequest(
          "workflow_owner_closed",
          `Workflow ${owner.ownerId} no longer admits subagents.`,
        );
      if (owner.runId !== undefined && (records.has(owner.runId) || !isAllocatedRunId(owner.runId)))
        return yield* invalidRequest(
          "owned_run_id_unavailable",
          `Run id ${owner.runId} was not reserved by this session or is already in use.`,
        );
      return undefined;
    });

  const ownedRecordLocked = (handle: OwnedRunHandle): RunRecord | undefined => {
    const record = records.get(handle.runId);
    return record?.owner?.claimToken === handle.claimToken &&
      completionClaimOwner(record, handle.generation) === handle.claimToken
      ? record
      : undefined;
  };

  const stoppedLocked = (handle: OwnedRunHandle): boolean => {
    const record = ownedRecordLocked(handle);
    return (
      record !== undefined &&
      (record.stoppedByParent ||
        record.view.state === "stopping" ||
        record.view.state === "stopped")
    );
  };

  const releaseLocked = (handle: OwnedRunHandle): void => {
    const record = ownedRecordLocked(handle);
    if (!record) return;
    const payload = record.completionGenerations.get(handle.generation);
    const unreadWriterReport =
      payload?.outcome === "completed" && record.view.writeIntent === "writer";
    if (!isLive(record) && !unreadWriterReport) return consumeLocked(record, handle);
    if (releaseCompletionClaim(record, handle.generation, handle.claimToken))
      delivery.wakeCompletionLocked();
    relinquishLocked(record);
  };

  const retire = (handle: OwnedRunHandle) =>
    stop(handle.runId).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Could not stop owned subagent: ${error.message}`).pipe(
          Effect.annotateLogs("runId", handle.runId),
        ),
      ),
      Effect.when(
        withLock(
          Effect.sync(() => {
            const record = ownedRecordLocked(handle);
            return record !== undefined && isLive(record);
          }),
        ),
      ),
      Effect.andThen(withLock(Effect.sync(() => releaseLocked(handle)))),
    );

  const openOwner: OwnedRunCoordinatorContract["openOwner"] = (ownerId) =>
    withLock(
      Effect.sync(() => {
        if (!owners.has(ownerId)) owners.set(ownerId, { open: true, runIds: new Set() });
      }),
    );

  const startOwned: OwnedRunCoordinatorContract["startOwned"] = (request, owner) => {
    let admitted: OwnedRunHandle | undefined;
    const ownership: RunOwnership = {
      runId: owner.runId,
      checkLocked: checkOwnerLocked(owner),
      admittedLocked: (record) => {
        const claimToken = allocateClaimToken();
        const generation = record.completionGeneration + 1;
        claimCompletion(record, generation, claimToken);
        record.owner = { ownerId: owner.ownerId, claimToken, generation, live: true };
        owners.get(owner.ownerId)?.runIds.add(record.view.id);
        admitted = { runId: record.view.id, ownerId: owner.ownerId, generation, claimToken };
      },
    };
    return Effect.uninterruptibleMask((restore) =>
      restore(start(request, ownership)).pipe(
        Effect.catchIf(
          () => admitted !== undefined,
          (error) =>
            withLock(Effect.sync(() => admitted !== undefined && stoppedLocked(admitted))).pipe(
              Effect.flatMap((stopped) => (stopped ? Effect.void : Effect.fail(error))),
            ),
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && admitted ? retire(admitted) : Effect.void,
        ),
        Effect.flatMap(() => {
          const handle = admitted;
          return handle
            ? Effect.addFinalizer(() => retire(handle)).pipe(Effect.as(handle))
            : Effect.fail(
                invalidRequest("owned_run_not_admitted", "The owned subagent was not admitted."),
              );
        }),
      ),
    );
  };

  const awaitStepLocked = (handle: OwnedRunHandle) =>
    Effect.suspend((): Effect.Effect<AwaitStep, InvalidSubagentRequestError> => {
      const record = ownedRecordLocked(handle);
      if (!record)
        return Effect.fail(
          invalidRequest(
            "owned_run_released",
            `Subagent ${handle.runId} is no longer owned by ${handle.ownerId}.`,
          ),
        );
      const spend: OwnedRunSpend = {
        usage: record.view.usage,
        toolUses: record.view.toolUses ?? 0,
      };
      const payload = record.completionGenerations.get(handle.generation);
      if (payload) {
        consumeLocked(record, handle);
        return Effect.succeed({
          outcome:
            payload.outcome === "completed"
              ? {
                  kind: "completed",
                  text: payload.finalText ?? "",
                  ...(payload.warning && { warning: payload.warning }),
                  ...spend,
                }
              : { kind: "failed", reason: payload.error ?? "Run failed.", ...spend },
        });
      }
      if (!isTerminalRunState(record.view.state))
        return Effect.succeed({ revision: currentRevision() });
      consumeLocked(record, handle);
      return Effect.succeed({
        outcome:
          record.view.state === "stopped"
            ? { kind: "stopped", reason: STOPPED_REASON, ...spend }
            : {
                kind: "failed",
                reason: record.view.error ?? "Run ended without a report.",
                ...spend,
              },
      });
    });

  const awaitOwned: OwnedRunCoordinatorContract["awaitOwned"] = (handle) =>
    Effect.uninterruptibleMask((restore) => {
      const loop = (): Effect.Effect<
        OwnedRunOutcome,
        InvalidSubagentRequestError | SubagentRuntimeClosedError
      > =>
        withLock(awaitStepLocked(handle)).pipe(
          Effect.flatMap((step) =>
            "outcome" in step
              ? Effect.succeed(step.outcome)
              : restore(waitForRevision(step.revision)).pipe(Effect.andThen(Effect.suspend(loop))),
          ),
        );
      return loop().pipe(Effect.onInterrupt(() => retire(handle)));
    });

  const closeOwner: OwnedRunCoordinatorContract["closeOwner"] = (ownerId) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const handles = yield* withLock(
          Effect.sync(() => {
            const entry = owners.get(ownerId);
            if (!entry) return [];
            entry.open = false;
            return [...entry.runIds].flatMap((runId): OwnedRunHandle[] => {
              const claim = records.get(runId)?.owner;
              return claim?.ownerId === ownerId
                ? [{ runId, ownerId, generation: claim.generation, claimToken: claim.claimToken }]
                : [];
            });
          }),
        );
        yield* Effect.forEach(handles, retire, { concurrency: "unbounded", discard: true });
        yield* withLock(
          Effect.sync(() => {
            for (const runId of owners.get(ownerId)?.runIds ?? []) {
              const record = records.get(runId);
              if (record?.owner?.ownerId === ownerId) relinquishLocked(record);
            }
            owners.delete(ownerId);
          }),
        );
      }),
    );

  return { openOwner, startOwned, awaitOwned, closeOwner };
}
