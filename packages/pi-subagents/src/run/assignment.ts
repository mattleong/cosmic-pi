import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { isOutcomeUncertain, type SubagentError, SubagentProcessError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import type { AssignmentActivationReplay } from "./settlement.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, snapshotView } from "./state.ts";
import { projectRunWarning, setRunWarning } from "./warnings.ts";

export interface RunAssignmentDependencies {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly startPrompt: (
    record: RunRecord,
    message: string,
    assignmentEpoch: number,
  ) => Effect.Effect<void, SubagentError>;
  /** Caller holds the service lock while draining one issuing assignment. */
  readonly activateAssignmentLocked: (
    record: RunRecord,
    now: number,
    runningView: SubagentRunView,
  ) => Effect.Effect<AssignmentActivationReplay>;
  readonly replayAssignmentActivation: (
    record: RunRecord,
    replay: AssignmentActivationReplay,
  ) => Effect.Effect<SubagentRunView>;
}

/** Owns prompt issue confirmation, rollback, and uncertain assignment retention. */
export function makeRunAssignment(dependencies: RunAssignmentDependencies) {
  const { withLock, publish, startPrompt, activateAssignmentLocked, replayAssignmentActivation } =
    dependencies;

  const confirmIssuedAssignment = (record: RunRecord, attemptToken: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
          if (
            record.assignment.attemptToken !== attemptToken ||
            record.assignment.phase !== "issuing" ||
            isInactiveRunRecord(record)
          )
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
                if (record.assignment.attemptToken === attemptToken)
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
          if (
            record.assignment.attemptToken !== attemptToken ||
            record.assignment.phase !== "issuing"
          )
            return undefined;
          record.assignment.outcomeUncertain = true;
          const diagnostic = sanitizeDiagnosticText(warning, MAX_ERROR_CHARS);
          record.warningSlots = setRunWarning(record.warningSlots, "system", diagnostic);
          record.view = {
            ...record.view,
            ...projectRunWarning(record.warningSlots, "system"),
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "warning",
              diagnostic,
              now,
            ),
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
