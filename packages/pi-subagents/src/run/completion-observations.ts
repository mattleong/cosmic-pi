import * as Effect from "effect/Effect";
import { claimCompletion, completionClaimOwner, releaseCompletionClaim } from "./completion.ts";
import { InvalidSubagentRequestError, SubagentRuntimeClosedError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import {
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type {
  SubagentAwaitUntil,
  SubagentRunObservation,
  SubagentServiceContract,
} from "./service.ts";
import { snapshotView } from "./state.ts";

export interface RunCompletionObservationDependencies {
  readonly records: ReadonlyMap<string, RunRecord>;
  /** The shared service lock. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The shared completion gate serializing claim acquisition against delivery. */
  readonly withCompletionGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The stored immutable snapshot, captured under the shared lock to prevent missed publications. */
  readonly currentProjection: () => SubagentProjection;
  /** Waits for a service publication strictly newer than the supplied revision. */
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  /** Claim-token allocation stays owned by the service. */
  readonly allocateClaimToken: () => string;
  readonly delivery: Pick<RunNotificationDelivery, "wakeCompletionLocked">;
}

/**
 * Owns exclusive completion-claim observation: claim acquisition/release under
 * the shared gate and lock, redacted competing observation, revision-driven
 * terminal waits, and claimed-receipt consumption.
 */
export function makeRunCompletionObservations(dependencies: RunCompletionObservationDependencies) {
  const {
    records,
    withLock,
    withCompletionGate,
    currentProjection,
    waitForRevision,
    allocateClaimToken,
    delivery,
  } = dependencies;

  const withTreeMetadata = (view: SubagentRunView): SubagentRunView => {
    const projected = currentProjection().runs.find((candidate) => candidate.id === view.id);
    return snapshotView({
      ...view,
      directChildCount: projected?.directChildCount ?? 0,
      descendantCount: projected?.descendantCount ?? 0,
    });
  };

  const redactCompletionReport = (view: SubagentRunView): SubagentRunView => {
    const { finalText: _finalText, ...withoutReport } = view;
    return snapshotView({
      ...withoutReport,
      sessionEvents: withoutReport.sessionEvents.map((event) =>
        event.type === "assistant"
          ? { ...event, text: "[report redacted: owned or already delivered]" }
          : event,
      ),
    });
  };

  const observeRecord = (record: RunRecord, claimToken?: string): SubagentRunObservation => {
    const generation = record.completionGeneration;
    const view = withTreeMetadata(record.view);
    if (!isAssignmentFinishedRunState(view.state)) return { run: view };
    const unresolved = record.completionGenerations.has(generation);
    const owns =
      unresolved &&
      claimToken !== undefined &&
      completionClaimOwner(record, generation) === claimToken;
    const observed: SubagentRunView = {
      ...view,
      reportStatus: !view.finalText?.trim()
        ? "missing"
        : !unresolved
          ? "delivered"
          : owns || completionClaimOwner(record, generation) === undefined
            ? "available"
            : "claimed",
    };
    return {
      run: owns ? snapshotView(observed) : redactCompletionReport(observed),
      ...(owns && {
        completionReceipt: {
          id: record.view.id,
          generation,
          claimToken,
        },
      }),
    };
  };

  const consumeCompletions: SubagentServiceContract["consumeCompletions"] = (receipts) =>
    withLock(
      Effect.sync(() => {
        for (const receipt of receipts) {
          const record = records.get(receipt.id);
          const completion = record?.completionGenerations.get(receipt.generation);
          if (
            !record ||
            !completion ||
            completionClaimOwner(record, receipt.generation) !== receipt.claimToken
          )
            continue;
          if (record.completionGenerations.get(receipt.generation) !== completion) continue;
          record.completionGenerations.delete(receipt.generation);
          record.completionClaims.delete(receipt.generation);
        }
      }),
    );

  interface CompletionClaim {
    readonly claimToken: string;
    readonly selected: ReadonlyArray<RunRecord>;
    readonly claimed: ReadonlyArray<{
      readonly record: RunRecord;
      readonly generation: number;
    }>;
    readonly missingIds: ReadonlyArray<string>;
  }
  const acquireCompletionClaims = (
    ids: ReadonlyArray<string>,
    claimAll: boolean,
    allowMissing = false,
  ) =>
    withCompletionGate(
      withLock(
        Effect.gen(function* () {
          const selected = ids.flatMap((id) => {
            const record = records.get(id);
            return record ? [record] : [];
          });
          const missingIds = ids.filter((id) => !records.has(id));
          if (!allowMissing && missingIds.length > 0)
            return yield* new InvalidSubagentRequestError({
              code: "subagent_runs_not_found",
              message: `Subagent runs not found: ${missingIds.join(", ")}. Use subagent_list to refresh active run IDs.`,
            });
          const claimToken = allocateClaimToken();
          const desired = claimAll
            ? selected.flatMap((record) => {
                const generation = isAssignmentFinishedRunState(record.view.state)
                  ? record.completionGeneration
                  : record.completionGeneration + 1;
                if (generation <= 0) return [];
                if (
                  isAssignmentFinishedRunState(record.view.state) &&
                  !record.completionGenerations.has(generation)
                )
                  return [];
                return [{ record, generation }];
              })
            : selected.flatMap((record) =>
                isAssignmentFinishedRunState(record.view.state) &&
                record.completionGenerations.has(record.completionGeneration)
                  ? [{ record, generation: record.completionGeneration }]
                  : [],
              );
          if (claimAll) {
            const conflict = desired.find(
              ({ record, generation }) => completionClaimOwner(record, generation) !== undefined,
            );
            if (conflict)
              return yield* new InvalidSubagentRequestError({
                code: "completion_claim_conflict",
                message: `Completion report ${conflict.record.view.id} generation ${conflict.generation} is already owned by another operation; wait for that operation to finish or cancel before retrying.`,
              });
          }
          const claimed = desired.filter(({ record, generation }) =>
            claimCompletion(record, generation, claimToken),
          );
          return { claimToken, selected, claimed, missingIds } satisfies CompletionClaim;
        }),
      ),
    );
  const releaseCompletionClaims = (claim: CompletionClaim) =>
    withLock(
      Effect.sync(() => {
        for (const claimed of claim.claimed)
          if (releaseCompletionClaim(claimed.record, claimed.generation, claim.claimToken))
            delivery.wakeCompletionLocked();
      }),
    );
  const waitForTerminalObservations = (
    claim: CompletionClaim,
    until: SubagentAwaitUntil,
    onUpdate?: (
      runs: ReadonlyArray<SubagentRunView>,
      projection?: ReadonlyArray<SubagentRunView>,
    ) => void,
  ): Effect.Effect<ReadonlyArray<SubagentRunObservation>, SubagentRuntimeClosedError> => {
    const emitUpdate = (runs: ReadonlyArray<SubagentRunView>) =>
      Effect.sync(() => {
        try {
          onUpdate?.(runs, currentProjection().runs);
        } catch {
          // Pi partial-result delivery is best effort and cannot own the waiter.
        }
      });
    const waitLoop = (): Effect.Effect<
      ReadonlyArray<SubagentRunObservation>,
      SubagentRuntimeClosedError
    > =>
      Effect.suspend(() =>
        withLock(
          Effect.sync(() => {
            const observations = claim.selected.map((record) =>
              observeRecord(record, claim.claimToken),
            );
            const runs = observations.map((observation) => observation.run);
            const terminalCount = runs.filter((run) =>
              isAssignmentFinishedRunState(run.state),
            ).length;
            const parentActionRequired = runs.some(isParentActionRequiredRun);
            const done =
              parentActionRequired ||
              (until === "any_finished" ? terminalCount > 0 : terminalCount === runs.length);
            if (done) return { done: true as const, runs, observations };
            return {
              done: false as const,
              runs,
              revision: currentProjection().revision,
            };
          }),
        ).pipe(
          Effect.tap(({ runs }) => emitUpdate(runs)),
          Effect.flatMap((step) =>
            step.done
              ? Effect.succeed(step.observations)
              : waitForRevision(step.revision).pipe(Effect.andThen(waitLoop())),
          ),
        ),
      );
    return waitLoop();
  };
  const withAwaitTerminalObservations: SubagentServiceContract["withAwaitTerminalObservations"] = (
    ids,
    until,
    onUpdate,
    use,
  ) => {
    if (ids.length === 0)
      return Effect.fail(
        new InvalidSubagentRequestError({
          code: "run_ids_required",
          message: "Await requires at least one subagent run ID.",
        }),
      );
    return Effect.acquireUseRelease(
      acquireCompletionClaims(ids, true),
      (claim) => waitForTerminalObservations(claim, until, onUpdate).pipe(Effect.flatMap(use)),
      releaseCompletionClaims,
    );
  };
  const withStatusObservations: SubagentServiceContract["withStatusObservations"] = (ids, use) =>
    Effect.acquireUseRelease(
      acquireCompletionClaims(ids, false, true),
      (claim) =>
        use({
          observations: claim.selected.map((record) => observeRecord(record, claim.claimToken)),
          missingIds: claim.missingIds,
        }),
      releaseCompletionClaims,
    );

  const awaitTerminal: SubagentServiceContract["awaitTerminal"] = (ids, until, onUpdate) =>
    withAwaitTerminalObservations(ids, until, onUpdate, (observations) =>
      consumeCompletions(
        observations.flatMap((observation) =>
          observation.completionReceipt ? [observation.completionReceipt] : [],
        ),
      ).pipe(Effect.as(observations.map((observation) => observation.run))),
    );

  return {
    redactCompletionReport,
    consumeCompletions,
    awaitTerminal,
    withAwaitTerminalObservations,
    withStatusObservations,
  };
}
