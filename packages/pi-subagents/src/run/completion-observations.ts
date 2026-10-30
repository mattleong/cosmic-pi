import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import {
  claimCompletion,
  completionClaimOwner,
  releaseCompletionClaim,
  type StartFailureHold,
} from "./completion.ts";
import { MAIN_AGENT_ID } from "./agent-messaging.ts";
import {
  invalidRequest,
  type SubagentError,
  type SubagentRuntimeClosedError,
  withGuidance,
  withGuidanceClause,
} from "./errors.ts";
import { snapshotRun, type RunContext, type RunRecord, type WithRunLock } from "./internal.ts";
import {
  isTerminalRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import type {
  AgentMessageArrivals,
  AgentMessageWatch,
  AgentMessageWatches,
} from "./message-watches.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { questionRecipientRunId } from "./notification-routing.ts";
import type {
  SubagentAwaitUntil,
  SubagentRunObservation,
  SubagentServiceContract,
} from "./service.ts";
import { snapshotView } from "./state.ts";
import { runTreeView } from "./tree.ts";

interface RunCompletionObservationDependencies extends Pick<RunContext, "records" | "withLock"> {
  readonly withCompletionGate: WithRunLock;
  readonly currentProjection: () => SubagentProjection;
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  readonly allocateClaimToken: () => string;
  readonly delivery: Pick<
    RunNotificationDelivery,
    "wakeCompletionLocked" | "signalOutboxChangedLocked" | "forgetTakenReportLocked"
  >;
  readonly messageWatches: Pick<AgentMessageWatches, "watchLocked">;
}

const reportStatusOf = (finalText: string | undefined, unresolved: boolean, available: boolean) =>
  finalText === undefined || !Str.trim(finalText)
    ? ("missing" as const)
    : !unresolved
      ? ("delivered" as const)
      : available
        ? ("available" as const)
        : ("claimed" as const);

const REDACTED_REPORT_TEXT = "[report redacted: owned or already delivered]";

const withoutCompletionReport = (view: SubagentRunView) => {
  const {
    finalText: _finalText,
    finalTextTruncation: _finalTextTruncation,
    reportArchive: _reportArchive,
    ...withoutReport
  } = view;
  return withoutReport;
};

const redactCompletionReport = (view: SubagentRunView): SubagentRunView => {
  const withoutReport = withoutCompletionReport(view);
  return snapshotView({
    ...withoutReport,
    sessionEvents: Arr.map(withoutReport.sessionEvents, (event) =>
      event.type === "assistant" ? Object.assign({}, event, { text: REDACTED_REPORT_TEXT }) : event,
    ),
  });
};

type ReportStatus = NonNullable<SubagentRunView["reportStatus"]>;

// Keyed by the frozen tree view, then by report status and redaction, so an unchanged target keeps
// its observed view across revisions, and concurrent waits on it don't evict each other's.
const observedViews = new WeakMap<SubagentRunView, Map<string, SubagentRunView>>();

/**
 * A frozen tree view with its report status, redacted unless the observer owns the report. Its
 * nested values are already frozen, so only the new objects are frozen here.
 */
const observedView = (
  view: SubagentRunView,
  reportStatus: ReportStatus,
  redacted: boolean,
): SubagentRunView => {
  const variants = observedViews.get(view) ?? new Map<string, SubagentRunView>();
  const key = `${reportStatus}:${redacted}`;
  const cached = variants.get(key);
  if (cached) return cached;
  const observed: SubagentRunView = redacted
    ? Object.freeze({
        ...withoutCompletionReport({ ...view, reportStatus }),
        sessionEvents: Object.freeze(
          Arr.map(view.sessionEvents, (event) =>
            event.type === "assistant"
              ? Object.freeze(Object.assign({}, event, { text: REDACTED_REPORT_TEXT }))
              : event,
          ),
        ),
      })
    : Object.freeze({ ...view, reportStatus });
  variants.set(key, observed);
  observedViews.set(view, variants);
  return observed;
};

// Each projection's runs by ID, shared by every wait observing that projection.
const projectedRunIndexes = new WeakMap<
  ReadonlyArray<SubagentRunView>,
  ReadonlyMap<string, SubagentRunView>
>();

const projectedRunIndex = (
  runs: ReadonlyArray<SubagentRunView>,
): ReadonlyMap<string, SubagentRunView> => {
  const cached = projectedRunIndexes.get(runs);
  if (cached) return cached;
  const index = new Map(Arr.map(runs, (run) => [run.id, run] as const));
  projectedRunIndexes.set(runs, index);
  return index;
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
    messageWatches,
  } = dependencies;

  // The record's current snapshot with the latest projection's child counts. While that
  // projection is current, this is the projection's own view of the run.
  const treeViewOf = (record: RunRecord): SubagentRunView => {
    const projected = projectedRunIndex(currentProjection().runs).get(record.view.id);
    return runTreeView(
      snapshotRun(record),
      projected?.directChildCount ?? 0,
      projected?.descendantCount ?? 0,
    );
  };

  const observeRecord = (record: RunRecord, claimToken: string): SubagentRunObservation => {
    const generation = record.completionGeneration;
    const view = treeViewOf(record);
    if (!isTerminalRunState(view.state)) return { run: view };
    const unresolved = record.completionGenerations.has(generation);
    const claimOwner = completionClaimOwner(record, generation);
    const owns = unresolved && claimOwner === claimToken;
    const reportStatus = reportStatusOf(
      view.finalText,
      unresolved,
      owns || claimOwner === undefined,
    );
    return {
      run: observedView(view, reportStatus, !owns),
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
          delivery.forgetTakenReportLocked(receipt.id, receipt.generation);
          delivery.signalOutboxChangedLocked();
        }
      }),
    ),
  );

  // The call reported every failure it held once it composed its result, so success consumes them;
  // any other exit hands them to their notices. Only `holdStartFailures` creates and ends a hold,
  // so no hold outlives its call.
  const endStartFailureHold = (hold: StartFailureHold, reported: boolean) =>
    withLock(
      Effect.sync(() => {
        hold.open = false;
        for (const [id, generation] of hold.held) {
          const record = records.get(id);
          if (!record || completionClaimOwner(record, generation) !== hold.claimToken) continue;
          record.completionClaims.delete(generation);
          if (!reported) {
            delivery.wakeCompletionLocked();
            continue;
          }
          record.completionGenerations.delete(generation);
          delivery.forgetTakenReportLocked(id, generation);
          delivery.signalOutboxChangedLocked();
        }
        hold.held.clear();
      }),
    );
  const holdStartFailures = <A, E, R>(
    use: (hold: StartFailureHold) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(
        (): StartFailureHold => ({ claimToken: allocateClaimToken(), open: true, held: new Map() }),
      ),
      use,
      (hold, exit) => endStartFailureHold(hold, Exit.isSuccess(exit)),
    );

  interface CompletionClaim {
    readonly claimToken: string;
    readonly selected: ReadonlyArray<RunRecord>;
    readonly claimed: ReadonlyArray<{
      readonly record: RunRecord;
      readonly generation: number;
    }>;
    /** Messages to the caller from here on end the wait; earlier ones don't. */
    readonly messages: AgentMessageWatch;
  }
  // An await claims every target's current or next outcome. Questions stay with their notices.
  const acquireCompletionClaims = (ids: ReadonlyArray<string>, recipient: string) =>
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
                withGuidance(
                  `Subagent runs not found: ${Arr.join(missingIds, ", ")}.`,
                  "Call agent_list for current run IDs.",
                ),
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
                withGuidanceClause(
                  `Completion report ${conflict.record.view.id} generation ${conflict.generation} is already owned by another operation`,
                  "wait for that operation to finish or cancel before retrying.",
                ),
              );
            const claimed = Arr.filter(desired, ({ record, generation }) =>
              claimCompletion(record, generation, claimToken),
            );
            if (claimed.length > 0) delivery.signalOutboxChangedLocked();
            const messages = messageWatches.watchLocked(recipient);
            return { claimToken, selected, claimed, messages } satisfies CompletionClaim;
          }),
          releaseCompletionClaims,
        ),
      ),
    );
  const releaseCompletionClaims = (claim: CompletionClaim) =>
    withLock(
      Effect.sync(() => {
        claim.messages.closeLocked();
        for (const claimed of claim.claimed)
          if (releaseCompletionClaim(claimed.record, claimed.generation, claim.claimToken))
            delivery.wakeCompletionLocked();
      }),
    );
  const withCompletionClaims = <A, E, R>(
    ids: ReadonlyArray<string>,
    recipient: string,
    use: (claim: CompletionClaim) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scopedWith((scope) =>
      acquireCompletionClaims(ids, recipient).pipe(Scope.provide(scope), Effect.flatMap(use)),
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
        ? [redactCompletionReport(treeViewOf(record))]
        : [],
    );
  };

  interface TerminalObservations {
    readonly observations: ReadonlyArray<SubagentRunObservation>;
    readonly questions: ReadonlyArray<SubagentRunView>;
    readonly messages: AgentMessageArrivals;
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
          const messages = claim.messages.arrivals();
          const parentActionRequired =
            Arr.some(runs, isParentActionRequiredRun) || questions.length > 0;
          const done =
            parentActionRequired ||
            messages.count > 0 ||
            (until === "any_finished" ? terminalCount > 0 : terminalCount === runs.length);
          if (done)
            return { done: true as const, runs, result: { observations, questions, messages } };
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
        messages?: AgentMessageArrivals,
      ) => Effect.Effect<A, E, R>,
      callerRunId?: string,
    ): Effect.fn.Return<A, SubagentError | E, R> {
      if (ids.length === 0)
        return yield* invalidRequest(
          "run_ids_required",
          "Await requires at least one subagent run ID.",
        );
      return yield* withCompletionClaims(ids, callerRunId ?? MAIN_AGENT_ID, (claim) =>
        waitForTerminalObservations(claim, until, callerRunId, onUpdate).pipe(
          Effect.flatMap(({ observations, questions, messages }) =>
            use(observations, questions, messages),
          ),
        ),
      );
    });
  return {
    redactCompletionReport,
    consumeCompletions,
    withAwaitTerminalObservations,
    holdStartFailures,
  };
}
