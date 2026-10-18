import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { invokeHostCallback } from "pi-cosmic-core";
import { claimCompletion, completionClaimOwner, releaseCompletionClaim } from "./completion.ts";
import { invalidRequest, type SubagentRuntimeClosedError } from "./errors.ts";
import { type RunContext, type RunRecord, type WithRunLock } from "./internal.ts";
import {
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { questionRecipientRunId } from "./notification-routing.ts";
import { failedStartRecoveryForRecord } from "./retry.ts";
import type {
  SubagentAwaitUntil,
  SubagentRunObservation,
  SubagentServiceContract,
  SubagentStatusObservationOptions,
} from "./service.ts";
import { snapshotView } from "./state.ts";

export interface RunCompletionObservationDependencies extends Pick<
  RunContext,
  "records" | "withLock"
> {
  readonly withCompletionGate: WithRunLock;
  readonly currentProjection: () => SubagentProjection;
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
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

const reportStatusOf = (finalText: string | undefined, unresolved: boolean, available: boolean) =>
  !finalText?.trim()
    ? ("missing" as const)
    : !unresolved
      ? ("delivered" as const)
      : available
        ? ("available" as const)
        : ("claimed" as const);

const startRecoveryOf = (record: RunRecord) =>
  record.view.state === "failed" && record.view.reportGeneration === 0
    ? failedStartRecoveryForRecord(record)
    : undefined;

const visibleRun = (
  observed: SubagentRunView,
  redacted: SubagentRunView | undefined,
  readBack: boolean,
): SubagentRunView =>
  redacted === undefined
    ? snapshotView(observed)
    : readBack
      ? snapshotView({ ...redacted, finalText: observed.finalText })
      : redacted;

const redactCompletionReport = (view: SubagentRunView): SubagentRunView => {
  const { finalText: _finalText, ...withoutReport } = view;
  return snapshotView({
    ...withoutReport,
    sessionEvents: withoutReport.sessionEvents.map((event) =>
      event.type === "assistant"
        ? Object.assign({}, event, { text: "[report redacted: owned or already delivered]" })
        : event,
    ),
  });
};

export function completionObservationOperations(
  dependencies: RunCompletionObservationDependencies,
) {
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
    const claimOwner = completionClaimOwner(record, generation);
    const owns = unresolved && claimToken !== undefined && claimOwner === claimToken;
    const observed: SubagentRunView = {
      ...view,
      reportStatus: reportStatusOf(view.finalText, unresolved, owns || claimOwner === undefined),
    };
    const readBack =
      options?.includeDeliveredReports === true &&
      observed.reportStatus === "delivered" &&
      [...record.completionClaims.values()].every((owner) => owner === claimToken);
    const redacted = owns ? undefined : redactCompletionReport(observed);
    const recovery = startRecoveryOf(record);
    return {
      run: visibleRun(observed, redacted, readBack),
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
          if (
            !record?.completionGenerations.has(receipt.generation) ||
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
  const acquireCompletionClaims = (ids: ReadonlyArray<string>, claimAll: boolean) =>
    withCompletionGate(
      withLock(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const selected = ids.flatMap((id) => {
              const record = records.get(id);
              return record ? [record] : [];
            });
            const missingIds = ids.filter((id) => !records.has(id));
            if (claimAll && missingIds.length > 0)
              return yield* invalidRequest(
                "subagent_runs_not_found",
                `Subagent runs not found: ${missingIds.join(", ")}. Call subagent_status without runIds to list current run IDs.`,
              );
            const claimToken = allocateClaimToken();
            const desired = selected.flatMap((record) => {
              const finished = isAssignmentFinishedRunState(record.view.state);
              const generation = record.completionGeneration + (finished ? 0 : 1);
              return (finished ? record.completionGenerations.has(generation) : claimAll)
                ? [{ record, generation }]
                : [];
            });
            if (claimAll) {
              const conflict = desired.find(
                ({ record, generation }) => completionClaimOwner(record, generation) !== undefined,
              );
              if (conflict)
                return yield* invalidRequest(
                  "completion_claim_conflict",
                  `Completion report ${conflict.record.view.id} generation ${conflict.generation} is already owned by another operation; wait for that operation to finish or cancel before retrying.`,
                );
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
      acquireCompletionClaims(ids, claimAll).pipe(Scope.provide(scope), Effect.flatMap(use)),
    );

  // Questions from runs the caller is not awaiting, which nonetheless reach this caller first.
  const questionsForCallerLocked = (
    claim: CompletionClaim,
    callerRunId: string | undefined,
  ): ReadonlyArray<SubagentRunView> => {
    const targets = new Set(claim.selected);
    return [...records.values()].flatMap((record) =>
      !targets.has(record) &&
      record.view.state === "waiting_for_parent" &&
      record.view.question !== undefined &&
      questionRecipientRunId(records, record.view.id) === callerRunId
        ? [redactCompletionReport(withTreeMetadata(record.view))]
        : [],
    );
  };

  interface TerminalObservations {
    readonly observations: ReadonlyArray<SubagentRunObservation>;
    readonly questions: ReadonlyArray<SubagentRunView>;
  }

  const waitForTerminalObservations = (
    claim: CompletionClaim,
    until: SubagentAwaitUntil,
    callerRunId: string | undefined,
    onUpdate?: (
      runs: ReadonlyArray<SubagentRunView>,
      projection?: ReadonlyArray<SubagentRunView>,
    ) => void,
  ): Effect.Effect<TerminalObservations, SubagentRuntimeClosedError> => {
    const emitUpdate = (runs: ReadonlyArray<SubagentRunView>) =>
      Effect.sync(() =>
        invokeHostCallback(() => onUpdate?.(runs, currentProjection().runs), undefined),
      );
    const waitLoop = (): Effect.Effect<TerminalObservations, SubagentRuntimeClosedError> =>
      withLock(
        Effect.sync(() => {
          const observations = claim.selected.map((record) =>
            observeRecord(record, claim.claimToken),
          );
          const runs = observations.map((observation) => observation.run);
          const terminalCount = runs.filter((run) =>
            isAssignmentFinishedRunState(run.state),
          ).length;
          const questions = questionsForCallerLocked(claim, callerRunId);
          const parentActionRequired = runs.some(isParentActionRequiredRun) || questions.length > 0;
          const done =
            parentActionRequired ||
            (until === "any_finished" ? terminalCount > 0 : terminalCount === runs.length);
          if (done) return { done: true as const, runs, result: { observations, questions } };
          return { done: false as const, runs, revision: currentProjection().revision };
        }),
      ).pipe(
        Effect.tap(({ runs }) => emitUpdate(runs)),
        Effect.flatMap((step) =>
          step.done
            ? Effect.succeed(step.result)
            : waitForRevision(step.revision).pipe(Effect.andThen(waitLoop())),
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
    callerRunId,
  ) => {
    if (ids.length === 0)
      return Effect.fail(
        invalidRequest("run_ids_required", "Await requires at least one subagent run ID."),
      );
    return withCompletionClaims(ids, true, (claim) =>
      waitForTerminalObservations(claim, until, callerRunId, onUpdate).pipe(
        Effect.flatMap(({ observations, questions }) =>
          use(observations, questions).pipe(
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
      withLock(
        Effect.sync(() =>
          claim.selected.map((record) => observeRecord(record, claim.claimToken, options)),
        ),
      ).pipe(Effect.flatMap((observations) => use({ observations, missingIds: claim.missingIds }))),
    );

  return {
    redactCompletionReport,
    consumeCompletions,
    withAwaitTerminalObservations,
    withStatusObservations,
  };
}
