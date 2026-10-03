import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { invokeHostCallback } from "pi-cosmic-core";
import { claimCompletion, completionClaimOwner, releaseCompletionClaim } from "./completion.ts";
import { InvalidSubagentRequestError, SubagentRuntimeClosedError } from "./errors.ts";
import {
  type RunContext,
  type RunRecord,
  type WithRunLock,
  workflowOwnedRunError,
} from "./internal.ts";
import {
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { failedStartRecoveryForRecord } from "./retry.ts";
import type {
  SubagentAwaitUntil,
  SubagentRunObservation,
  SubagentServiceContract,
  SubagentStatusObservationOptions,
} from "./service.ts";
import { snapshotView } from "./state.ts";

export interface RunCompletionObservationDependencies extends RunContext {
  /** The shared notification gate serializing claim acquisition against delivery. */
  readonly withCompletionGate: WithRunLock;
  /** The stored immutable snapshot, captured under the shared lock to prevent missed publications. */
  readonly currentProjection: () => SubagentProjection;
  /** Waits for a service publication strictly newer than the supplied revision. */
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  /** Claim-token allocation stays owned by the service. */
  readonly allocateClaimToken: () => string;
  readonly delivery: Pick<
    RunNotificationDelivery,
    | "wakeCompletionLocked"
    | "claimQuestionsLocked"
    | "questionReceiptLocked"
    | "acknowledgeQuestionsLocked"
    | "releaseQuestionClaimsLocked"
  >;
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

  /** Caller must hold the service lock. */
  const observeRecord = (
    record: RunRecord,
    claimToken?: string,
    options?: SubagentStatusObservationOptions,
  ): SubagentRunObservation => {
    const generation = record.completionGeneration;
    const view = withTreeMetadata(record.view);
    if (!isAssignmentFinishedRunState(view.state))
      return {
        run: view,
        ...(claimToken && {
          questionReceipt: delivery.questionReceiptLocked(record, claimToken),
        }),
      };
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
    // Read-back returns only the latest in-memory report and never a receipt. Any claim
    // held by another operation, including one waiting for a later generation, keeps it redacted.
    const readBack =
      options?.includeDeliveredReports === true &&
      observed.reportStatus === "delivered" &&
      [...record.completionClaims.values()].every((owner) => owner === claimToken);
    const redacted = owns ? undefined : redactCompletionReport(observed);
    // Recovery facts come from the record, never from the public view. Like retry claims,
    // they cover only a failed initial assignment.
    const recovery =
      record.view.state === "failed" && record.view.reportGeneration === 0
        ? failedStartRecoveryForRecord(record)
        : undefined;
    return {
      run:
        redacted === undefined
          ? snapshotView(observed)
          : readBack
            ? snapshotView({ ...redacted, finalText: observed.finalText })
            : redacted,
      ...(owns && {
        completionReceipt: {
          id: record.view.id,
          generation,
          claimToken,
        },
      }),
      ...(recovery && { recovery }),
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
    readonly ownsQuestions: boolean;
  }
  /** Claiming all awaited runs requires every id; status observation tolerates missing ids. */
  const acquireCompletionClaims = (ids: ReadonlyArray<string>, claimAll: boolean) =>
    withCompletionGate(
      withLock(
        // Wait for both permits interruptibly. Mask only insertion and finalizer installation.
        Effect.acquireRelease(
          Effect.gen(function* () {
            const selected = ids.flatMap((id) => {
              const record = records.get(id);
              return record ? [record] : [];
            });
            const missingIds = ids.filter((id) => !records.has(id));
            if (claimAll && missingIds.length > 0)
              return yield* new InvalidSubagentRequestError({
                code: "subagent_runs_not_found",
                message: `Subagent runs not found: ${missingIds.join(", ")}. Use subagent_list to refresh active run IDs.`,
              });
            const ownedFailure = claimAll
              ? selected
                  .map((record) => workflowOwnedRunError(record, "be awaited directly"))
                  .find((error) => error !== undefined)
              : undefined;
            if (ownedFailure) return yield* ownedFailure;
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
            if (claimAll) delivery.claimQuestionsLocked(selected, claimToken);
            return {
              claimToken,
              selected,
              claimed,
              missingIds,
              ownsQuestions: claimAll,
            } satisfies CompletionClaim;
          }),
          releaseCompletionClaims,
        ),
      ),
    );
  const releaseCompletionClaims = (claim: CompletionClaim) =>
    withLock(
      Effect.sync(() => {
        for (const claimed of claim.claimed)
          if (releaseCompletionClaim(claimed.record, claimed.generation, claim.claimToken))
            delivery.wakeCompletionLocked();
        if (claim.ownsQuestions)
          delivery.releaseQuestionClaimsLocked(claim.selected, claim.claimToken);
      }),
    );
  const withCompletionClaims = <A, E, R>(
    ids: ReadonlyArray<string>,
    claimAll: boolean,
    use: (claim: CompletionClaim) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scopedWith((scope) =>
      acquireCompletionClaims(ids, claimAll).pipe(
        Scope.provide(scope),
        // Do not provide our private claim scope to the caller's use effect.
        Effect.flatMap(use),
      ),
    );

  const waitForTerminalObservations = (
    claim: CompletionClaim,
    until: SubagentAwaitUntil,
    onUpdate?: (
      runs: ReadonlyArray<SubagentRunView>,
      projection?: ReadonlyArray<SubagentRunView>,
    ) => void,
  ): Effect.Effect<ReadonlyArray<SubagentRunObservation>, SubagentRuntimeClosedError> => {
    // Pi partial-result delivery is best effort and cannot own the waiter.
    const emitUpdate = (runs: ReadonlyArray<SubagentRunView>) =>
      Effect.sync(() =>
        invokeHostCallback(() => onUpdate?.(runs, currentProjection().runs), undefined),
      );
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
    questionCoverage,
  ) => {
    if (ids.length === 0)
      return Effect.fail(
        new InvalidSubagentRequestError({
          code: "run_ids_required",
          message: "Await requires at least one subagent run ID.",
        }),
      );
    return withCompletionClaims(ids, true, (claim) =>
      waitForTerminalObservations(claim, until, onUpdate).pipe(
        Effect.flatMap((observations) =>
          use(observations).pipe(
            // Only a successfully constructed result owns the question. On cancellation,
            // failure, or defect the scoped claim release wakes the outbox instead.
            Effect.flatMap((result) => {
              const covered = questionCoverage?.(result);
              return withLock(
                Effect.sync(() =>
                  delivery.acknowledgeQuestionsLocked(
                    observations.flatMap((observation) =>
                      observation.questionReceipt &&
                      (covered === undefined || covered.has(observation.run.id))
                        ? [observation.questionReceipt]
                        : [],
                    ),
                  ),
                ),
              ).pipe(Effect.as(result), Effect.uninterruptible);
            }),
          ),
        ),
      ),
    );
  };
  const withStatusObservations: SubagentServiceContract["withStatusObservations"] = (
    ids,
    use,
    options,
  ) =>
    withCompletionClaims(ids, false, (claim) =>
      use({
        observations: claim.selected.map((record) =>
          observeRecord(record, claim.claimToken, options),
        ),
        missingIds: claim.missingIds,
      }),
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
