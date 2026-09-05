import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { QuestionnaireOwner } from "pi-ask-user/protocol";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState } from "./model.ts";
import { InvalidSubagentRequestError, type SubagentError } from "./errors.ts";

const expired = () =>
  new InvalidSubagentRequestError({
    code: "questionnaire_owner_expired",
    message: "The questionnaire's owning Pi assignment is no longer active.",
  });

/** Synchronous registry transitions; no read-modify-write crosses an Effect yield. */
export const makeQuestionnaireLifetimes = (isClosed: () => boolean) => {
  // Weak record ownership bounds retention to the coordinator's own retained run history.
  const seen = new WeakMap<RunRecord, { epoch: number; ids: Set<string> }>();
  const entries = new Map<
    string,
    {
      readonly record: RunRecord;
      readonly current: () => boolean;
      readonly revoked: Deferred.Deferred<void>;
      readonly settled: Deferred.Deferred<void>;
    }
  >();
  const invalidate = Effect.suspend(() =>
    Effect.forEach(
      [...entries.values()].filter((entry) => !entry.current()),
      (entry) => Deferred.succeed(entry.revoked, undefined),
      { discard: true },
    ),
  );
  // Called outside the service lock before process release. Unlike publication, cleanup joins.
  const drain = (record: RunRecord) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...entries.values()].filter((entry) => entry.record === record),
        (entry) =>
          Deferred.succeed(entry.revoked, undefined).pipe(
            Effect.andThen(Deferred.await(entry.settled)),
          ),
        { discard: true },
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => seen.delete(record))));
  const own = <A, R>(
    record: RunRecord,
    requestId: string,
    execute: (owner: QuestionnaireOwner) => Effect.Effect<A, SubagentError, R>,
  ): Effect.Effect<A, SubagentError, R> => {
    // Capture authenticated assignment at dispatch, not after the execution fiber starts.
    const owner = { runId: record.view.id, assignmentEpoch: record.assignment.epoch, requestId };
    return Effect.gen(function* () {
      const current = () =>
        !isClosed() &&
        record.view.runtime === "pi" &&
        !record.stoppedByParent &&
        !record.cleanupPending &&
        !record.pauseRequested &&
        record.view.state !== "paused" &&
        record.view.state !== "stopping" &&
        isActiveRunState(record.view.state) &&
        record.assignment.epoch === owner.assignmentEpoch &&
        (record.assignment.phase === "running" || record.assignment.phase === "issuing");
      const key = `${owner.runId}:${requestId}`;
      const revoked = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const entry = { record, current, revoked, settled };
      return yield* Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (!current() || entries.has(key)) return Effect.fail(expired());
          const previous = seen.get(record);
          const history =
            previous?.epoch === owner.assignmentEpoch
              ? previous
              : { epoch: owner.assignmentEpoch, ids: new Set<string>() };
          if (history.ids.has(requestId) || history.ids.size >= 256)
            return Effect.fail(
              new InvalidSubagentRequestError({
                code: "questionnaire_request_conflict",
                message:
                  "The questionnaire identity was already used or this assignment reached its questionnaire limit.",
              }),
            );
          history.ids.add(requestId);
          seen.set(record, history);
          entries.set(key, entry);
          return Effect.succeed(entry);
        }),
        () =>
          Effect.suspend(() => (current() ? execute(owner) : Effect.fail(expired()))).pipe(
            Effect.raceFirst(Deferred.await(revoked).pipe(Effect.andThen(Effect.fail(expired())))),
            Effect.flatMap((result) =>
              current() ? Effect.succeed(result) : Effect.fail(expired()),
            ),
          ),
        () =>
          Effect.sync(() => {
            if (entries.get(key) === entry) entries.delete(key);
          }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
      );
    });
  };
  return { own, invalidate, drain };
};
