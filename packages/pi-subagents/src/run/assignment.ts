import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { isOutcomeUncertain, SubagentProcessError } from "./errors.ts";
import { isInactiveRunRecord, type RunContext, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import type { RunProcessControls } from "./process-lifecycle.ts";
import type { RunSettlement } from "./settlement.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, snapshotView } from "./state.ts";
import { emptyRunWarningSlots, recordRunWarning } from "./warnings.ts";

export interface RunAssignmentDependencies extends RunContext {
  readonly startPrompt: RunProcessControls["startPrompt"];
  /** Caller holds the service lock while draining one issuing assignment. */
  readonly activateAssignmentLocked: RunSettlement["activateAssignmentLocked"];
  readonly replayAssignmentActivation: RunSettlement["replayAssignmentActivation"];
}

/** Run-start evidence may change the view before the issuing prompt confirms. */
export const isCurrentIssuingAssignment = (record: RunRecord, attemptToken: string): boolean =>
  record.assignment.attemptToken === attemptToken &&
  record.assignment.phase === "issuing" &&
  !isInactiveRunRecord(record);

/** Rolls over to a new issuing assignment and a starting view; caller holds the service lock. */
export const beginNextAssignmentLocked = (
  record: RunRecord,
  attemptToken: string,
  now: number,
  viewPatch: Partial<SubagentRunView>,
): void => {
  record.pausedAssignmentEpoch = undefined;
  record.latestAssistantText = undefined;
  record.warningSlots = emptyRunWarningSlots();
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
    endedAt: undefined,
    warning: undefined,
    warningSource: undefined,
    systemWarning: undefined,
    error: undefined,
    lastActivityAt: now,
  };
};

/** Owns prompt issue confirmation, rollback, and uncertain assignment retention. */
export function makeRunAssignment(dependencies: RunAssignmentDependencies) {
  const { withLock, publish, startPrompt, activateAssignmentLocked, replayAssignmentActivation } =
    dependencies;

  const confirmIssuedAssignment = (record: RunRecord, attemptToken: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
          if (!isCurrentIssuingAssignment(record, attemptToken))
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          record.assignment.outcomeUncertain = false;
          return yield* activateAssignmentLocked(record, now, {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            finalText: undefined,
            lastActivityAt: now,
          });
        }),
      );
      return result.kind === "unchanged"
        ? result.view
        : yield* replayAssignmentActivation(record, result);
    });

  const submitPrompt = (
    record: RunRecord,
    message: string,
    operation: "start" | "resume",
    attemptToken: string,
  ) =>
    startPrompt(record, message, record.assignment.epoch).pipe(
      Effect.tapError((error) =>
        error._tag === "SubagentProcessError" && isOutcomeUncertain(error)
          ? withLock(
              Effect.sync(() => {
                if (isCurrentIssuingAssignment(record, attemptToken))
                  record.assignment.outcomeUncertain = true;
              }),
            )
          : Effect.void,
      ),
      Effect.mapError((error) => {
        const outcomeUncertain = error._tag === "SubagentProcessError" && isOutcomeUncertain(error);
        if (!outcomeUncertain || (operation === "start" && record.view.writeIntent !== "writer"))
          return error;
        return operation === "start"
          ? new SubagentProcessError({
              operation,
              code: "start_outcome_uncertain",
              message: `The writer task may have been accepted, but startup could not confirm the outcome. Inspect the workspace and subagent status before starting another writer. (${error.message})`,
            })
          : new SubagentProcessError({
              operation,
              code: "resume_outcome_uncertain",
              message: `The resume prompt may already have applied. Inspect subagent status before retrying. (${error.message})`,
            });
      }),
      Effect.andThen(confirmIssuedAssignment(record, attemptToken)),
    );

  const retainUncertainAssignment = (record: RunRecord, attemptToken: string, warning: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const replay = yield* withLock(
        Effect.gen(function* () {
          if (!isCurrentIssuingAssignment(record, attemptToken)) return undefined;
          record.assignment.outcomeUncertain = true;
          const diagnostic = sanitizeDiagnosticText(warning, MAX_ERROR_CHARS);
          record.view = {
            ...record.view,
            ...recordRunWarning(record, record.view.sessionEvents, "system", diagnostic, now),
          };
          if (!record.assignment.startedObserved) {
            yield* publish;
            return undefined;
          }
          return yield* activateAssignmentLocked(record, now, {
            ...record.view,
            state: "running",
            endedAt: undefined,
            finalText: undefined,
            lastActivityAt: now,
          });
        }),
      );
      if (replay) yield* replayAssignmentActivation(record, replay);
    });

  return { submitPrompt, retainUncertainAssignment };
}

export type RunAssignment = ReturnType<typeof makeRunAssignment>;
