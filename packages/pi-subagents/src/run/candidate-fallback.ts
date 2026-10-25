import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Str from "effect/String";
import { firstLineMessage } from "pi-cosmic-core/message-text";
import type { BackendDriver } from "../backend/model.ts";
import { skippedCandidateRoute, type SkippedProfileCandidate } from "../profiles/model.ts";
import { SubagentProcessError, subagentErrorCode, type SubagentError } from "./errors.ts";
import { clearRunActivity, type RunInitialization, type RunRecord } from "./internal.ts";
import { backendLaunchRequest, type LaunchPlan } from "./launch-records.ts";
import {
  nextRouteCandidate,
  type StartSubagentRequest,
  type SubagentNextCandidate,
} from "./model.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";
import { recordRunWarning } from "./warnings.ts";

/**
 * Startup failures of the candidate itself: no loaded provider offers its model, or the child chose
 * another model or effort. The route's next candidate may still start.
 */
const CANDIDATE_STARTUP_FAILURE_CODES: ReadonlySet<string> = new Set([
  "pi_model_not_found",
  "pi_model_mismatch",
  "pi_effort_unsupported",
]);

/** A failed startup attempt on one candidate, and whether the launch may move past it. */
export interface CandidateStartupFailure {
  readonly failure: SkippedProfileCandidate;
  readonly fallBack: boolean;
}

/**
 * Classifies an attempt's failure, and holds the run's settlements when the launch may move past
 * it: only while the run is still preparing, so the task was never issued, and only on a listed
 * startup failure. Request, admission, cleanup, transport, uncertain-outcome, and uncoded failures
 * never qualify. The backend's recorded failure explains an attempt better than the start error
 * it caused.
 */
export const candidateStartupFailureLocked = (
  record: RunRecord,
  attempt: StartSubagentRequest,
  error: SubagentError,
): CandidateStartupFailure => {
  const cause = record.backendFailure ?? error;
  const code = subagentErrorCode(cause);
  const failure: SkippedProfileCandidate = {
    ...(attempt.selection?.candidateIndex !== undefined && {
      candidateIndex: attempt.selection.candidateIndex,
    }),
    candidate: skippedCandidateRoute(attempt),
    code,
    reason: sanitizeDiagnosticText(cause.message, MAX_ERROR_CHARS),
  };
  const fallBack =
    attempt.routeFallback !== undefined &&
    record.assignment.phase === "preparing" &&
    record.view.state === "starting" &&
    !record.stoppedByParent &&
    CANDIDATE_STARTUP_FAILURE_CODES.has(code);
  // Settlements from the failed candidate's closing process stay pending instead of ending the run;
  // the next candidate's install or the start's failure releases them.
  if (fallBack) record.initialization ??= { settled: Deferred.makeUnsafe<void>() };
  return { failure, fallBack };
};

/** A candidate as a failed run's next-candidate hint writes it. */
const candidateLabel = ({ model, effort }: SkippedProfileCandidate["candidate"]) =>
  `${model}${effort === "default" ? "" : `:${effort}`}`;

const failureReason = ({ code, reason }: SkippedProfileCandidate): string =>
  `[${code}] ${firstLineMessage(reason, "startup failed")}`;

/** Names the candidates whose startup failed, then the one the run moved to, then why. */
const fallbackWarning = (failed: ReadonlyArray<SkippedProfileCandidate>, next: string): string => {
  const labels = Arr.join(
    Arr.map(failed, ({ candidate }) => candidateLabel(candidate)),
    ", ",
  );
  const reasons = Arr.join(
    Arr.map(failed, (failure) =>
      failed.length === 1
        ? failureReason(failure)
        : `${candidateLabel(failure.candidate)} ${failureReason(failure)}`,
    ),
    "; ",
  );
  return `Fell back from ${labels} to ${next} before the task was issued: ${reasons}`;
};

/** Why a launch stopped moving through its route before trying another candidate. */
export interface FallbackStop {
  readonly code: string;
  readonly reason: string;
}

/**
 * The start's final failure once it moved past at least one candidate or stopped trying, naming
 * each candidate it tried and why it stopped; the failure's own first line still leads.
 */
export const candidateFallbackFailure = (
  error: SubagentError,
  tried: ReadonlyArray<SkippedProfileCandidate>,
  stop?: FallbackStop,
): SubagentError => {
  const [summary, ...detail] = Str.split(error.message, "\n");
  const attempts = Arr.join(
    Arr.map(tried, ({ candidate, code }) => `${candidateLabel(candidate)} [${code}]`),
    "; ",
  );
  return SubagentProcessError.make({
    operation: "start",
    code: subagentErrorCode(error),
    message: Arr.join(
      [
        summary,
        `Route candidates tried: ${attempts}.`,
        ...(stop ? [`Fallback stopped: [${stop.code}] ${firstLineMessage(stop.reason, "")}`] : []),
        ...detail,
      ],
      "\n",
    ),
  });
};

interface CandidateRetarget {
  readonly plan: LaunchPlan;
  readonly driver: BackendDriver;
  readonly scope: Scope.Closeable;
  readonly cleanupSettlement: Deferred.Deferred<"confirmed" | "quarantined">;
  readonly initialization: RunInitialization;
  /** Every candidate whose startup failed so far, the latest last. */
  readonly failed: ReadonlyArray<SkippedProfileCandidate>;
  readonly now: number;
}

/**
 * Moves a still-preparing run, whose failed candidate's processes are gone and whose writer-pool
 * membership was kept for it, onto the next candidate. Identity, assignment, workspace, writer
 * pool, usage, and history stay; the scope, driver, launch, and route facts are the new
 * candidate's. The warning names every failed candidate.
 */
export const retargetRunLocked = (record: RunRecord, retarget: CandidateRetarget): void => {
  const { plan, driver, failed, now } = retarget;
  const next = plan.request;
  const previous = record.initialization;
  record.initialization = retarget.initialization;
  // The failed candidate's pending settlement is discarded with its process.
  if (previous) Deferred.doneUnsafe(previous.settled, Effect.void);
  // Its processes are confirmed gone, and its writer-pool membership passes to the next candidate.
  Deferred.doneUnsafe(record.cleanupSettlement, Effect.succeed("confirmed"));
  record.writerPoolHandover = undefined;
  record.scope = retarget.scope;
  record.cleanupSettlement = retarget.cleanupSettlement;
  record.cleanupDisposition = "none";
  record.cleanupRecovery = undefined;
  record.cleanupVerification = undefined;
  record.closingScope = undefined;
  record.closingScopeSettled = undefined;
  record.driver = driver;
  record.launch = backendLaunchRequest(plan, {
    id: record.view.id,
    name: record.launch.name,
  });
  record.backendFailure = undefined;
  clearRunActivity(record);
  const {
    pid: _pid,
    sessionId: _sessionId,
    sessionFile: _sessionFile,
    cleanup: _cleanup,
    ...view
  } = record.view;
  const label = candidateLabel(next);
  const latest = Option.getOrUndefined(Arr.last(failed));
  const warning = fallbackWarning(failed, label);
  const notice = latest ? fallbackWarning([latest], label) : warning;
  record.view = {
    ...view,
    model: next.model,
    effort: next.effort,
    context: next.context,
    openaiFastMode: next.openaiFastMode,
    capabilities: driver.capabilities,
    ...(next.selection && { selection: next.selection }),
    ...(next.routeContinuation && { nextCandidate: nextRouteCandidate(next.routeContinuation) }),
    lastActivityAt: now,
    ...recordRunWarning(
      record,
      view.sessionEvents,
      "system",
      sanitizeDiagnosticText(warning, MAX_ERROR_CHARS),
      now,
      sanitizeDiagnosticText(notice, MAX_ERROR_CHARS),
    ),
  };
};

/** The candidates passed over, without the run's own. */
const passedOver = (
  record: RunRecord,
  skippedCandidates: ReadonlyArray<SkippedProfileCandidate>,
): ReadonlyArray<SkippedProfileCandidate> => {
  const own = record.view.selection.candidateIndex;
  return Arr.filter(
    skippedCandidates,
    (skipped) => own === undefined || skipped.candidateIndex !== own,
  );
};

/**
 * Records that no later candidate passed planning and preflight: the run stays on its failed
 * candidate, lists the ones passed over, and names no next candidate.
 */
export const exhaustRouteLocked = (
  record: RunRecord,
  skippedCandidates: ReadonlyArray<SkippedProfileCandidate>,
): void => {
  record.view = {
    ...record.view,
    selection: {
      ...record.view.selection,
      skippedCandidates: passedOver(record, skippedCandidates),
    },
    nextCandidate: "none",
  };
};

interface FallbackStopRecord {
  readonly stop: FallbackStop;
  /** Every candidate whose startup failed, the latest last. */
  readonly failed: ReadonlyArray<SkippedProfileCandidate>;
  /** The candidates passed over before the stop, once the route lookup got that far. */
  readonly skippedCandidates?: ReadonlyArray<SkippedProfileCandidate> | undefined;
  /** The failed run's next-candidate hint: kept or replaced. */
  readonly nextCandidate: SubagentNextCandidate | "keep";
  readonly now: number;
}

/**
 * Records why the launch stopped moving through its route, as a system warning that names every
 * failed candidate, and replaces the failed run's next-candidate hint.
 */
export const stopFallbackLocked = (record: RunRecord, stopped: FallbackStopRecord): void => {
  const { stop, failed, skippedCandidates, nextCandidate, now } = stopped;
  const labels = Arr.join(
    Arr.map(failed, ({ candidate }) => candidateLabel(candidate)),
    ", ",
  );
  const warning = sanitizeDiagnosticText(
    `Stopped falling back after ${labels} failed to start: [${stop.code}] ${firstLineMessage(stop.reason, "no reason given")}`,
    MAX_ERROR_CHARS,
  );
  const { nextCandidate: previous, ...view } = record.view;
  const hint = nextCandidate === "keep" ? previous : nextCandidate;
  record.view = {
    ...view,
    ...(skippedCandidates && {
      selection: { ...view.selection, skippedCandidates: passedOver(record, skippedCandidates) },
    }),
    ...(hint && { nextCandidate: hint }),
    lastActivityAt: now,
    ...recordRunWarning(record, view.sessionEvents, "system", warning, now),
  };
};
