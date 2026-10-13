import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ProfileRouteContinuation } from "../profiles/model.ts";
import {
  invalidRequest,
  type InvalidSubagentRequestError,
  type SubagentNotFoundError,
} from "./errors.ts";
import { type RunContext, type RunRecord, workflowOwnedRunError } from "./internal.ts";
import {
  hasUnresolvedSteeringDelivery,
  type FailedStartRecovery,
  type SubagentRunView,
} from "./model.ts";
import { snapshotView } from "./state.ts";

export interface SubagentRetryClaim {
  readonly source: SubagentRunView;
  readonly continuation: ProfileRouteContinuation;
  readonly claimToken: string;
}

const invalid = (code: string, message: string) =>
  invalidRequest(
    code,
    `${message} Earlier work and writes may already exist; inspect them before authorizing replacement work.`,
  );

export const remainingRouteCandidates = (continuation: ProfileRouteContinuation): number =>
  Math.max(0, continuation.candidates.length - continuation.selectedCandidateIndex - 1);

const retryBlockedByHistory = (record: RunRecord): boolean =>
  record.view.supersededByRunId !== undefined ||
  record.assignment.outcomeUncertain ||
  hasUnresolvedSteeringDelivery(record.view) ||
  record.cleanupDisposition === "quarantined" ||
  record.view.retryBlocked === true;

const retryCleanupPending = (record: RunRecord): boolean =>
  record.cleanupPending ||
  record.cleanupDisposition === "pending" ||
  record.runStateReclaimState === "running";

const retryResourcesHeld = (record: RunRecord): boolean =>
  record.process !== undefined ||
  record.writerPool !== undefined ||
  record.evictionClaim !== undefined ||
  record.retryClaim !== undefined;

const retryDispositionFor = (
  record: RunRecord,
  hasContinuation: boolean,
  hasRemainingCandidate: boolean,
): FailedStartRecovery["retryDisposition"] => {
  if (!hasContinuation) return "unavailable";
  if (record.view.retryExhausted === true || !hasRemainingCandidate) return "exhausted";
  if (retryBlockedByHistory(record)) return "blocked";
  if (retryCleanupPending(record)) return "pending";
  return retryResourcesHeld(record) ? "blocked" : "eligible";
};

export const failedStartRecoveryForRecord = (record: RunRecord): FailedStartRecovery => {
  const continuation = record.routeContinuation;
  const remainingCandidateCount = continuation ? remainingRouteCandidates(continuation) : 0;
  const hasRemainingCandidate = remainingCandidateCount > 0;
  const retryDisposition = retryDispositionFor(
    record,
    continuation !== undefined,
    hasRemainingCandidate,
  );
  return Object.freeze({
    runId: record.view.id,
    cleanupDisposition: record.cleanupDisposition,
    retryDisposition,
    remainingCandidateCount,
    hasRemainingCandidate,
  });
};

const retrySourceFailure = (
  record: RunRecord,
  id: string,
): InvalidSubagentRequestError | undefined => {
  if (record.view.state !== "failed")
    return invalid(
      "retry_source_not_failed",
      `Subagent ${id} must be failed before its next profile candidate can be tried.`,
    );
  if (record.view.reportGeneration > 0)
    return invalid(
      "retry_assignment_not_initial",
      `Subagent ${id} failed after a later assignment; its launch-time task cannot be replayed safely on another candidate.`,
    );
  return undefined;
};

const retryRouteFailure = (
  record: RunRecord,
  id: string,
  continuation: ProfileRouteContinuation,
): InvalidSubagentRequestError | undefined => {
  if (record.view.retryExhausted === true || remainingRouteCandidates(continuation) === 0)
    return invalid(
      "retry_route_exhausted",
      `Profile ${continuation.profile} has no configured candidate after candidate ${continuation.selectedCandidateIndex + 1}. Only now may the parent choose a generalist replacement.`,
    );
  if (record.view.supersededByRunId)
    return invalid(
      "retry_already_superseded",
      `Subagent ${id} was already continued as ${record.view.supersededByRunId}.`,
    );
  if (record.assignment.outcomeUncertain || hasUnresolvedSteeringDelivery(record.view))
    return invalid(
      "retry_outcome_uncertain",
      `Subagent ${id} may have accepted or executed its task; automatic next-candidate continuation is blocked. Inspect the run before deciding how to recover.`,
    );
  return undefined;
};

const retryResourceFailure = (
  record: RunRecord,
  id: string,
): InvalidSubagentRequestError | undefined => {
  if (
    record.cleanupDisposition !== "confirmed" ||
    record.process !== undefined ||
    record.writerPool !== undefined
  )
    return invalid(
      "retry_cleanup_unconfirmed",
      `Subagent ${id} still owns backend or writer resources; next-candidate continuation fails closed.`,
    );
  if (record.view.retryBlocked)
    return invalid(
      "retry_blocked",
      `Subagent ${id} continuation encountered ownership uncertainty and remains fail-closed.`,
    );
  if (record.runStateReclaimState === "running")
    return invalid(
      "retry_cleanup_pending",
      `Subagent ${id} is still reclaiming private run state; retry after cleanup finishes.`,
    );
  if (record.evictionClaim)
    return invalid(
      "retry_record_claimed",
      `Subagent ${id} is already claimed by history reclamation; refresh run state before retrying.`,
    );
  if (record.retryClaim)
    return invalid(
      "retry_claim_conflict",
      `Subagent ${id} already has a next-candidate continuation in progress.`,
    );
  return undefined;
};

export function makeRunRetry(
  dependencies: Pick<RunContext, "records" | "withLock" | "publish" | "requireRecord"> & {
    readonly allocateClaimToken: () => string;
  },
) {
  const { records, withLock, publish, allocateClaimToken, requireRecord } = dependencies;

  const claimRetryContinuation = (
    id: string,
  ): Effect.Effect<SubagentRetryClaim, InvalidSubagentRequestError | SubagentNotFoundError> =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        const ownedFailure = workflowOwnedRunError(record, "be retried");
        if (ownedFailure) return yield* ownedFailure;
        const sourceFailure = retrySourceFailure(record, id);
        if (sourceFailure) return yield* sourceFailure;
        const continuation = record.routeContinuation;
        if (!continuation)
          return yield* invalid(
            "retry_route_unavailable",
            `Subagent ${id} has no launch-time route continuation. Start a new profiled run instead.`,
          );
        const routeFailure = retryRouteFailure(record, id, continuation);
        if (routeFailure) return yield* routeFailure;
        if (record.cleanupPending) return { waitForCleanup: record.cleanupSettlement } as const;
        const resourceFailure = retryResourceFailure(record, id);
        if (resourceFailure) return yield* resourceFailure;
        const claimToken = allocateClaimToken();
        record.retryClaim = { token: claimToken };
        return {
          source: snapshotView(record.view),
          continuation,
          claimToken,
        } satisfies SubagentRetryClaim;
      }),
    ).pipe(
      Effect.filterOrElse(
        (result): result is SubagentRetryClaim => !("waitForCleanup" in result),
        ({ waitForCleanup }) =>
          Deferred.await(waitForCleanup).pipe(
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
          ),
      ),
    );

  const releaseRetryClaim = (id: string, claimToken: string): Effect.Effect<void> =>
    withLock(
      Effect.sync(() => {
        const record = records.get(id);
        if (record?.retryClaim?.token === claimToken) record.retryClaim = undefined;
      }),
    );

  const finishRetryClaim = (id: string, claimToken: string, outcome: "exhausted" | "blocked") =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        if (record.retryClaim?.token !== claimToken)
          return yield* invalid(
            "retry_claim_stale",
            `Subagent ${id} no longer owns this retry claim.`,
          );
        record.retryClaim = undefined;
        record.view = {
          ...record.view,
          ...(outcome === "exhausted" ? { retryExhausted: true } : { retryBlocked: true }),
        };
        yield* publish;
        return undefined;
      }),
    );

  return {
    claimRetryContinuation,
    releaseRetryClaim,
    exhaustRetryClaim: (id: string, claimToken: string) =>
      finishRetryClaim(id, claimToken, "exhausted"),
    blockRetryClaim: (id: string, claimToken: string) =>
      finishRetryClaim(id, claimToken, "blocked"),
  };
}
