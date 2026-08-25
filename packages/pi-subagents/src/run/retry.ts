import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ProfileRouteContinuation } from "../profiles/model.ts";
import { InvalidSubagentRequestError, SubagentNotFoundError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { snapshotView } from "./state.ts";

export interface SubagentRetryClaim {
  readonly source: SubagentRunView;
  readonly continuation: ProfileRouteContinuation;
  readonly claimToken: string;
}

export interface RunRetryDependencies {
  readonly records: ReadonlyMap<string, RunRecord>;
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly allocateClaimToken: () => string;
}

const invalid = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });

/** Owns exclusive failed-run continuation claims and route-exhaustion publication. */
export function makeRunRetry(dependencies: RunRetryDependencies) {
  const { records, withLock, publish, allocateClaimToken } = dependencies;

  const requireRecord = (id: string): Effect.Effect<RunRecord, SubagentNotFoundError> => {
    const record = records.get(id);
    return record
      ? Effect.succeed(record)
      : Effect.fail(new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` }));
  };

  const claimRetryContinuation = (
    id: string,
  ): Effect.Effect<SubagentRetryClaim, InvalidSubagentRequestError | SubagentNotFoundError> =>
    Effect.suspend(() =>
      withLock(
        Effect.gen(function* () {
          const record = yield* requireRecord(id);
          if (record.view.state !== "failed")
            return yield* invalid(
              "retry_source_not_failed",
              `Subagent ${id} must be failed before its next profile candidate can be tried.`,
            );
          if (record.view.reportGeneration > 0)
            return yield* invalid(
              "retry_assignment_not_initial",
              `Subagent ${id} failed after a later assignment; its launch-time task cannot be replayed safely on another candidate.`,
            );
          const continuation = record.routeContinuation;
          if (!continuation)
            return yield* invalid(
              "retry_route_unavailable",
              `Subagent ${id} has no launch-time route continuation. Start a new profiled run instead.`,
            );
          if (
            record.retryExhausted ||
            continuation.selectedCandidateIndex + 1 >= continuation.candidates.length
          )
            return yield* invalid(
              "retry_route_exhausted",
              `Profile ${continuation.profile} has no configured candidate after candidate ${continuation.selectedCandidateIndex + 1}. Only now may the parent choose a generalist replacement.`,
            );
          if (record.view.supersededByRunId)
            return yield* invalid(
              "retry_already_superseded",
              `Subagent ${id} was already continued as ${record.view.supersededByRunId}.`,
            );
          if (record.assignment.outcomeUncertain)
            return yield* invalid(
              "retry_outcome_uncertain",
              `Subagent ${id} may have accepted or executed its task; automatic next-candidate continuation is blocked. Inspect the run before deciding how to recover.`,
            );
          if (record.cleanupPending) return { waitForCleanup: record.cleanupSettlement } as const;
          if (record.process !== undefined || record.writerPool !== undefined)
            return yield* invalid(
              "retry_cleanup_unconfirmed",
              `Subagent ${id} still owns backend or writer resources; next-candidate continuation fails closed.`,
            );
          if (record.view.retryBlocked)
            return yield* invalid(
              "retry_blocked",
              `Subagent ${id} continuation encountered ownership uncertainty and remains fail-closed.`,
            );
          if (record.runStateReclaimState === "running")
            return yield* invalid(
              "retry_cleanup_pending",
              `Subagent ${id} is still reclaiming private run state; retry after cleanup finishes.`,
            );
          if (record.evictionClaim)
            return yield* invalid(
              "retry_record_claimed",
              `Subagent ${id} is already claimed by history reclamation; refresh run state before retrying.`,
            );
          if (record.retryClaim)
            return yield* invalid(
              "retry_claim_conflict",
              `Subagent ${id} already has a next-candidate continuation in progress.`,
            );
          const claimToken = allocateClaimToken();
          record.retryClaim = { token: claimToken };
          return {
            source: snapshotView(record.view),
            continuation,
            claimToken,
          } satisfies SubagentRetryClaim;
        }),
      ).pipe(
        Effect.flatMap((result) => {
          if (!("waitForCleanup" in result)) return Effect.succeed(result);
          return Deferred.await(result.waitForCleanup).pipe(
            Effect.flatMap((outcome) =>
              outcome === "confirmed"
                ? claimRetryContinuation(id)
                : Effect.fail(
                    invalid(
                      "retry_cleanup_unconfirmed",
                      `Subagent ${id} cleanup could not be confirmed; next-candidate continuation is blocked.`,
                    ),
                  ),
            ),
          );
        }),
      ),
    );

  const releaseRetryClaim = (id: string, claimToken: string): Effect.Effect<void> =>
    withLock(
      Effect.sync(() => {
        const record = records.get(id);
        if (record?.retryClaim?.token === claimToken) record.retryClaim = undefined;
      }),
    );

  const exhaustRetryClaim = (
    id: string,
    claimToken: string,
  ): Effect.Effect<void, InvalidSubagentRequestError | SubagentNotFoundError> =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        if (record.retryClaim?.token !== claimToken)
          return yield* invalid(
            "retry_claim_stale",
            `Subagent ${id} no longer owns this retry claim.`,
          );
        record.retryClaim = undefined;
        record.retryExhausted = true;
        record.view = { ...record.view, retryExhausted: true };
        yield* publish;
      }),
    );

  const blockRetryClaim = (
    id: string,
    claimToken: string,
  ): Effect.Effect<void, InvalidSubagentRequestError | SubagentNotFoundError> =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        if (record.retryClaim?.token !== claimToken)
          return yield* invalid(
            "retry_claim_stale",
            `Subagent ${id} no longer owns this retry claim.`,
          );
        record.retryClaim = undefined;
        record.view = { ...record.view, retryBlocked: true };
        yield* publish;
      }),
    );

  return {
    claimRetryContinuation,
    releaseRetryClaim,
    exhaustRetryClaim,
    blockRetryClaim,
  };
}
