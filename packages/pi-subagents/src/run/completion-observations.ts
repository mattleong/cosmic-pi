import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";
import { invokeHostCallback } from "pi-cosmic-core";
import { claimCompletion, completionClaimOwner, releaseCompletionClaim } from "./completion.ts";
import { invalidRequest, type SubagentError, type SubagentRuntimeClosedError } from "./errors.ts";
import { snapshotRun, type RunContext, type RunRecord, type WithRunLock } from "./internal.ts";
import {
  isTerminalRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { questionRecipientRunId } from "./notification-routing.ts";
import type {
  SubagentAwaitUntil,
  SubagentRunObservation,
  SubagentServiceContract,
} from "./service.ts";
import { snapshotView } from "./state.ts";

interface RunCompletionObservationDependencies extends Pick<RunContext, "records" | "withLock"> {
  readonly withCompletionGate: WithRunLock;
  readonly currentProjection: () => SubagentProjection;
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  readonly allocateClaimToken: () => string;
  readonly delivery: Pick<
    RunNotificationDelivery,
    "wakeCompletionLocked" | "signalOutboxChangedLocked"
  >;
}

const reportStatusOf = (finalText: string | undefined, unresolved: boolean, available: boolean) =>
  finalText === undefined || !Str.trim(finalText)
    ? ("missing" as const)
    : !unresolved
      ? ("delivered" as const)
      : available
        ? ("available" as const)
        : ("claimed" as const);

const redactCompletionReport = (view: SubagentRunView): SubagentRunView => {
  const {
    finalText: _finalText,
    finalTextTruncation: _finalTextTruncation,
    reportArchive: _reportArchive,
    ...withoutReport
  } = view;
  return snapshotView({
    ...withoutReport,
    sessionEvents: Arr.map(withoutReport.sessionEvents, (event) =>
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
    const projected = Option.getOrUndefined(
      Arr.findFirst(currentProjection().runs, (candidate) => candidate.id === view.id),
    );
    return snapshotView({
      ...view,
      directChildCount: projected?.directChildCount ?? 0,
      descendantCount: projected?.descendantCount ?? 0,
    });
  };

  const observeRecord = (record: RunRecord, claimToken: string): SubagentRunObservation => {
    const generation = record.completionGeneration;
    const view = withTreeMetadata(snapshotRun(record));
    if (!isTerminalRunState(view.state)) return { run: view };
    const unresolved = record.completionGenerations.has(generation);
    const claimOwner = completionClaimOwner(record, generation);
    const owns = unresolved && claimOwner === claimToken;
    const observed: SubagentRunView = {
      ...view,
      reportStatus: reportStatusOf(view.finalText, unresolved, owns || claimOwner === undefined),
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

  const consumeCompletions: SubagentServiceContract["consumeCompletions"] = Effect.fn(
    "SubagentService.consumeCompletions",
  )((receipts: Parameters<SubagentServiceContract["consumeCompletions"]>[0]) =>
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
          delivery.signalOutboxChangedLocked();
        }
      }),
    ),
  );

  interface CompletionClaim {
    readonly claimToken: string;
    readonly selected: ReadonlyArray<RunRecord>;
    readonly claimed: ReadonlyArray<{
      readonly record: RunRecord;
      readonly generation: number;
    }>;
  }
  // An await claims every target's current or next outcome. Questions stay with their notices.
  const acquireCompletionClaims = (ids: ReadonlyArray<string>) =>
    withCompletionGate(
      withLock(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const selected = Arr.flatMap(ids, (id) => {
              const record = records.get(id);
              return record ? [record] : [];
            });
            const missingIds = Arr.filter(ids, (id) => !records.has(id));
            if (missingIds.length > 0)
              return yield* invalidRequest(
                "subagent_runs_not_found",
                `Subagent runs not found: ${Arr.join(missingIds, ", ")}. Call agent_list for current run IDs.`,
              );
            const claimToken = allocateClaimToken();
            const desired = Arr.flatMap(selected, (record) => {
              const finished = isTerminalRunState(record.view.state);
              const generation = record.completionGeneration + (finished ? 0 : 1);
              return !finished || record.completionGenerations.has(generation)
                ? [{ record, generation }]
                : [];
            });
            const conflict = Option.getOrUndefined(
              Arr.findFirst(
                desired,
                ({ record, generation }) => completionClaimOwner(record, generation) !== undefined,
              ),
            );
            if (conflict)
              return yield* invalidRequest(
                "completion_claim_conflict",
                `Completion report ${conflict.record.view.id} generation ${conflict.generation} is already owned by another operation; wait for that operation to finish or cancel before retrying.`,
              );
            const claimed = Arr.filter(desired, ({ record, generation }) =>
              claimCompletion(record, generation, claimToken),
            );
            if (claimed.length > 0) delivery.signalOutboxChangedLocked();
            return { claimToken, selected, claimed } satisfies CompletionClaim;
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
      }),
    );
  const withCompletionClaims = <A, E, R>(
    ids: ReadonlyArray<string>,
    use: (claim: CompletionClaim) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scopedWith((scope) =>
      acquireCompletionClaims(ids).pipe(Scope.provide(scope), Effect.flatMap(use)),
    );

  // Questions from runs the caller is not awaiting, which nonetheless reach this caller first.
  const questionsForCallerLocked = (
    claim: CompletionClaim,
    callerRunId: string | undefined,
  ): ReadonlyArray<SubagentRunView> => {
    const targets = new Set(claim.selected);
    return Arr.flatMap([...records.values()], (record) =>
      !targets.has(record) &&
      record.view.state === "waiting_for_parent" &&
      record.view.question !== undefined &&
      questionRecipientRunId(records, record.view.id) === callerRunId
        ? [redactCompletionReport(withTreeMetadata(snapshotRun(record)))]
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
          const observations = Arr.map(claim.selected, (record) =>
            observeRecord(record, claim.claimToken),
          );
          const runs = Arr.map(observations, (observation) => observation.run);
          const terminalCount = Arr.filter(runs, (run) => isTerminalRunState(run.state)).length;
          const questions = questionsForCallerLocked(claim, callerRunId);
          const parentActionRequired =
            Arr.some(runs, isParentActionRequiredRun) || questions.length > 0;
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
  const withAwaitTerminalObservations: SubagentServiceContract["withAwaitTerminalObservations"] =
    Effect.fn("SubagentService.await")(function* <A, E, R>(
      ids: ReadonlyArray<string>,
      until: SubagentAwaitUntil,
      onUpdate: Parameters<SubagentServiceContract["withAwaitTerminalObservations"]>[2],
      use: (
        observations: ReadonlyArray<SubagentRunObservation>,
        questions?: ReadonlyArray<SubagentRunView>,
      ) => Effect.Effect<A, E, R>,
      callerRunId?: string,
    ): Effect.fn.Return<A, SubagentError | E, R> {
      if (ids.length === 0)
        return yield* invalidRequest(
          "run_ids_required",
          "Await requires at least one subagent run ID.",
        );
      return yield* withCompletionClaims(ids, (claim) =>
        waitForTerminalObservations(claim, until, callerRunId, onUpdate).pipe(
          Effect.flatMap(({ observations, questions }) => use(observations, questions)),
        ),
      );
    });
  return {
    redactCompletionReport,
    consumeCompletions,
    withAwaitTerminalObservations,
  };
}
