import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  failureFields,
  type GuidedText,
  isOutcomeUncertain,
  SubagentProcessError,
  withCause,
  withGuidance,
} from "./errors.ts";
import {
  isInactiveRunRecord,
  recordLatestAssistantText,
  snapshotRun,
  type RunContext,
  type RunRecord,
  type StoredRunView,
} from "./internal.ts";
import type { RunProcessControls } from "./process-lifecycle.ts";
import type { RunSettlement } from "./settlement.ts";
import { sanitizeGuidedDiagnostic } from "./state.ts";
import { recordRunWarning } from "./warnings.ts";

interface RunAssignmentDependencies extends Pick<RunContext, "withLock" | "publish"> {
  readonly startPrompt: RunProcessControls["startPrompt"];
  readonly activateAssignmentLocked: RunSettlement["activateAssignmentLocked"];
  readonly replayAssignmentActivation: RunSettlement["replayAssignmentActivation"];
}

const isCurrentIssuingAssignment = (record: RunRecord, attemptToken: string): boolean =>
  record.assignment.attemptToken === attemptToken &&
  record.assignment.phase === "issuing" &&
  !isInactiveRunRecord(record);

export const beginNextAssignmentLocked = (
  record: RunRecord,
  attemptToken: string,
  now: number,
  viewPatch: Partial<StoredRunView>,
): void => {
  record.pausedAssignmentEpoch = undefined;
  recordLatestAssistantText(record, undefined);
  record.warningSlots = {};
  record.assignment = {
    epoch: record.nextAssignmentEpoch++,
    phase: "issuing",
    attemptToken,
    startedObserved: false,
    outcomeUncertain: false,
    pendingRunSettled: false,
  };
  record.view = {
    ...record.view,
    ...viewPatch,
    state: "starting",
    // Older report payloads remain owned by their completion generations.
    finalText: undefined,
    finalTextTruncation: undefined,
    reportArchive: undefined,
    endedAt: undefined,
    error: undefined,
    errorArchive: undefined,
    lastActivityAt: now,
  };
};

const runningView = (record: RunRecord, now: number): StoredRunView => ({
  ...record.view,
  state: "running",
  endedAt: undefined,
  error: undefined,
  finalText: undefined,
  lastActivityAt: now,
});

export function assignmentOperations(dependencies: RunAssignmentDependencies) {
  const { withLock, publish, startPrompt, activateAssignmentLocked, replayAssignmentActivation } =
    dependencies;

  const confirmIssuedAssignment = Effect.fn("SubagentAssignment.confirmIssuedAssignment")(
    function* (record: RunRecord, attemptToken: string) {
      const result = yield* withLock(
        Effect.gen(function* () {
          if (!isCurrentIssuingAssignment(record, attemptToken))
            return { kind: "unchanged" as const, view: snapshotRun(record) };
          const now = yield* Clock.currentTimeMillis;
          record.assignment.outcomeUncertain = false;
          return yield* activateAssignmentLocked(record, runningView(record, now));
        }),
      );
      return result.kind === "unchanged"
        ? result.view
        : yield* replayAssignmentActivation(record, result);
    },
  );

  // A report proves the attempt's task was issued, so it answers a start request that failed
  // afterwards: an uncertain start's own events can activate and settle the assignment first.
  const answerFailedStart = (record: RunRecord, attemptToken: string) =>
    withLock(
      Effect.sync(() =>
        record.assignment.attemptToken === attemptToken && record.assignment.phase === "reported"
          ? snapshotRun(record)
          : undefined,
      ),
    );

  const submitPrompt = (
    record: RunRecord,
    message: string,
    operation: "start" | "resume",
    attemptToken: string,
  ) =>
    startPrompt(record, message, record.assignment.epoch).pipe(
      Effect.catchTag("SubagentProcessError", (error) => {
        if (!isOutcomeUncertain(error)) return Effect.fail(error);
        const reported =
          operation === "resume"
            ? SubagentProcessError.make({
                operation,
                code: "resume_outcome_uncertain",
                ...failureFields(
                  withCause(
                    withGuidance(
                      "The resume prompt may already have applied.",
                      "Inspect the run with agent_read before retrying.",
                    ),
                    error,
                  ),
                ),
              })
            : record.view.writeIntent === "writer"
              ? SubagentProcessError.make({
                  operation,
                  code: "start_outcome_uncertain",
                  ...failureFields(
                    withCause(
                      withGuidance(
                        "The writer task may have been accepted, but startup could not confirm the outcome.",
                        "Inspect the workspace and the run with agent_read before starting another writer.",
                      ),
                      error,
                    ),
                  ),
                })
              : error;
        return withLock(
          Effect.sync(() => {
            if (isCurrentIssuingAssignment(record, attemptToken))
              record.assignment.outcomeUncertain = true;
          }),
        ).pipe(Effect.andThen(Effect.fail(reported)));
      }),
      Effect.andThen(confirmIssuedAssignment(record, attemptToken)),
      Effect.catch((error) =>
        answerFailedStart(record, attemptToken).pipe(
          Effect.filterOrFail(Predicate.isNotUndefined, () => error),
        ),
      ),
    );

  const retainUncertainAssignment = Effect.fn("SubagentAssignment.retainUncertainAssignment")(
    function* (record: RunRecord, attemptToken: string, warning: string | GuidedText) {
      const replay = yield* withLock(
        Effect.gen(function* () {
          if (!isCurrentIssuingAssignment(record, attemptToken)) return undefined;
          const now = yield* Clock.currentTimeMillis;
          record.assignment.outcomeUncertain = true;
          const diagnostic = sanitizeGuidedDiagnostic(warning);
          record.view = {
            ...record.view,
            ...recordRunWarning(record, record.view.sessionEvents, "system", diagnostic, now),
          };
          if (!record.assignment.startedObserved) {
            yield* publish;
            return undefined;
          }
          return yield* activateAssignmentLocked(record, {
            ...record.view,
            state: "running",
            endedAt: undefined,
            finalText: undefined,
            lastActivityAt: now,
          });
        }),
      );
      if (replay) yield* replayAssignmentActivation(record, replay);
    },
  );

  return { submitPrompt, retainUncertainAssignment };
}

export type RunAssignment = ReturnType<typeof assignmentOperations>;
