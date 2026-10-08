/**
 * Pure projections from domain observations and outcomes to version-1 orchestration contracts.
 * Inputs are run views, receipts, recovery facts, and typed failures, never persisted details or
 * formatted text. Every field is picked explicitly, so task, cwd, session, process, and event
 * data cannot reach a contract, and free-form metadata passes the core redaction helpers.
 */
import {
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import {
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  type FailedStartRecovery,
  type SubagentRunView,
} from "../run/model.ts";
import type { SubagentAwaitUntil, SubagentRunObservation } from "../run/service.ts";
import { MAX_NAME_CHARS, sanitizeName } from "../run/state.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { runAttention } from "../run/attention.ts";
import {
  MAX_CONTRACT_ERROR_CHARS,
  MAX_CONTRACT_MESSAGE_CHARS,
  MAX_CONTRACT_QUESTION_CHARS,
  MAX_CONTRACT_REPORT_CHARS,
  SUBAGENT_CONTRACT_ID,
  SUBAGENT_CONTRACT_VERSION,
  type ContractAttention,
  type ContractFailure,
  type ContractLifecycleAction,
  type ContractLifecycleResult,
  type ContractRecovery,
  type ContractReport,
  type ContractRunTarget,
  type ContractStartLaunch,
  type ContractWithheldReport,
  type ContractWithheldRunTarget,
  type SubagentAwaitContract,
  type SubagentContractTool,
  type SubagentLifecycleContract,
  type SubagentStartContract,
  type SubagentStatusContract,
} from "./contract-schema.ts";
import { nonNegativeInteger } from "./details.ts";
import { MAX_FAILURE_CODE_CHARS } from "./details-schema.ts";
import type { SubagentActionFailure, SubagentStartFailure, SubagentStartOutcome } from "./model.ts";
import { actionFailureDisposition } from "./outcome.ts";
import type { SubagentStartSpec } from "./schema.ts";

export const envelope = <Tool extends SubagentContractTool>(tool: Tool) =>
  ({ contract: SUBAGENT_CONTRACT_ID, version: SUBAGENT_CONTRACT_VERSION, tool }) as const;

const batchOutcome = <Success extends string>(succeeded: number, total: number, success: Success) =>
  succeeded === 0 ? ("failed" as const) : succeeded === total ? success : ("partial" as const);

/** Redacted, single-line, bounded metadata; blank or control-only text is absent. */
export const metadata = (value: string | undefined, maximum: number): string | undefined => {
  const line = value === undefined ? "" : sanitizeTerminalLine(value);
  return line ? sanitizeDiagnosticError(line, { maximumLength: maximum }) : undefined;
};

const projectName = (value: string): string => sanitizeName(metadata(value, MAX_NAME_CHARS) ?? "");

const knownProfile = (profile: string | undefined): ProfileId | undefined =>
  PROFILE_IDS.find((id) => id === profile);

const hasId = (id: string | undefined): id is string => id !== undefined && id.length > 0;

const projectRecovery = (recovery: FailedStartRecovery): ContractRecovery => ({
  cleanup: recovery.cleanupDisposition,
  disposition: recovery.retryDisposition,
  remainingCandidateCount: nonNegativeInteger(recovery.remainingCandidateCount),
});

export const projectFailure = (
  action: string,
  failure: Pick<SubagentActionFailure, "code" | "message" | "pendingDelivery">,
): ContractFailure => {
  const code = metadata(failure.code, MAX_FAILURE_CODE_CHARS);
  return {
    disposition: actionFailureDisposition(action, failure),
    ...(code !== undefined && { code }),
    message: metadata(failure.message, MAX_CONTRACT_MESSAGE_CHARS) ?? "Action failed.",
  };
};

const projectAttention = (run: SubagentRunView): ContractAttention | undefined => {
  const attention = runAttention(run);
  if (attention?.kind !== "question") return attention;
  const message = sanitizeDiagnosticContent(stripTerminalControls(attention.message), {
    maximumLength: MAX_CONTRACT_QUESTION_CHARS,
  }).trim();
  return message ? { kind: "question", message } : { kind: "question-unavailable" };
};

const projectWarnings = (run: SubagentRunView): ContractRunTarget["warnings"] => {
  const warnings: Array<ContractRunTarget["warnings"][number]> = [];
  const warning = metadata(run.warning, MAX_CONTRACT_MESSAGE_CHARS);
  const system = metadata(run.systemWarning, MAX_CONTRACT_MESSAGE_CHARS);
  if (warning !== undefined)
    warnings.push({ ...(run.warningSource && { source: run.warningSource }), message: warning });
  // Source identity, not prose, decides whether the system slot repeats the current warning.
  const repeatsCurrent = run.warningSource === "system" && run.systemWarning === run.warning;
  if (system !== undefined && !repeatsCurrent) warnings.push({ source: "system", message: system });
  return warnings;
};

const WITHHELD_REPORT_STATUS = {
  available: "deferred",
  claimed: "claimed",
  delivered: "already_delivered",
  missing: "missing",
} as const satisfies Record<
  NonNullable<SubagentRunView["reportStatus"]>,
  ContractWithheldReport["status"]
>;

/** Every report fact that carries no text; used wherever this call does not deliver one. */
const withheldReport = (run: SubagentRunView): ContractWithheldReport => ({
  status: !isAssignmentFinishedRunState(run.state)
    ? "not_finished"
    : run.reportStatus === undefined
      ? "unknown"
      : WITHHELD_REPORT_STATUS[run.reportStatus],
});

const reportText = (value: string | undefined): string | undefined => {
  const cleaned = value === undefined ? "" : stripTerminalControls(value);
  return cleaned.trim() && cleaned.length <= MAX_CONTRACT_REPORT_CHARS ? cleaned : undefined;
};

/**
 * Text only for this call's owned receipt whose complete report was rendered (`delivered`, the
 * same receipts the caller consumes) or a parent-requested delivered read-back (`read_back`,
 * which carries no receipt). Everything else is an explicit withheld disposition.
 */
const observedReport = (
  { run, completionReceipt }: SubagentRunObservation,
  fullyRenderedIds: ReadonlySet<string>,
): ContractReport => {
  if (!isAssignmentFinishedRunState(run.state)) return { status: "not_finished" };
  if (completionReceipt !== undefined) {
    if (!fullyRenderedIds.has(run.id)) return { status: "deferred" };
    if (!stripTerminalControls(run.finalText ?? "").trim()) return { status: "missing" };
    const text = reportText(run.finalText);
    return text === undefined ? { status: "deferred" } : { status: "delivered", text };
  }
  const readBack = run.reportStatus === "delivered" ? reportText(run.finalText) : undefined;
  return readBack === undefined ? withheldReport(run) : { status: "read_back", text: readBack };
};

const targetFields = (
  run: SubagentRunView,
  recovery?: FailedStartRecovery,
): Omit<ContractRunTarget, "report"> => {
  const profile = knownProfile(run.profile);
  const attention = projectAttention(run);
  const error = metadata(run.error, MAX_CONTRACT_ERROR_CHARS);
  return {
    runId: run.id,
    name: projectName(run.name) || "subagent",
    ...(profile !== undefined && { profile }),
    state: run.state,
    finished: isAssignmentFinishedRunState(run.state),
    reportGeneration: nonNegativeInteger(run.reportGeneration),
    writeIntent: run.writeIntent,
    capabilities: [...new Set(run.capabilities)],
    ...(hasId(run.predecessorRunId) && { predecessorRunId: run.predecessorRunId }),
    ...(hasId(run.supersededByRunId) && { successorRunId: run.supersededByRunId }),
    parentActionRequired: isParentActionRequiredRun(run),
    ...(attention !== undefined && { attention }),
    ...(recovery?.runId === run.id && { retry: projectRecovery(recovery) }),
    warnings: projectWarnings(run),
    ...(error !== undefined && { error }),
  };
};

/** Report-free target facts for discovery and management receipts. */
export const withheldTarget = (run: SubagentRunView): ContractWithheldRunTarget => ({
  ...targetFields(run),
  report: withheldReport(run),
});

const observedTarget = (
  observation: SubagentRunObservation,
  fullyRenderedIds: ReadonlySet<string>,
): ContractRunTarget => ({
  ...targetFields(observation.run, observation.recovery),
  report: observedReport(observation, fullyRenderedIds),
});

/** Settled, never confirmed: a missing outcome cannot prove that nothing was admitted. */
const UNOBSERVED_LAUNCH: SubagentStartFailure = {
  index: -1,
  code: "launch_outcome_uncertain",
  message: "Launch outcome was not observed.",
};

const projectLaunch = (
  spec: SubagentStartSpec,
  index: number,
  outcome: SubagentStartOutcome | undefined,
): ContractStartLaunch => {
  if (outcome !== undefined && "run" in outcome) {
    const { run } = outcome;
    const profile = knownProfile(run.profile ?? spec.profile);
    return {
      index,
      status: "started",
      runId: run.id,
      name: projectName(run.name) || projectName(spec.name ?? "") || `launch ${index + 1}`,
      ...(profile !== undefined && { profile }),
      state: run.state,
      writeIntent: run.writeIntent,
    };
  }
  const failure = outcome?.failure ?? UNOBSERVED_LAUNCH;
  const name = projectName(spec.name ?? "");
  const profile = knownProfile(outcome?.resolvedRoute?.profile ?? spec.profile);
  const admitted = failure.admittedRun;
  return {
    index,
    status: "failed",
    ...(name && { name }),
    ...(profile !== undefined && { profile }),
    failure: projectFailure("start", failure),
    ...(admitted !== undefined && {
      admittedRun: { runId: admitted.runId, ...projectRecovery(admitted) },
    }),
  };
};

/** Request-ordered launch receipts from the raw batch outcomes. */
export const startContract = (
  specs: ReadonlyArray<SubagentStartSpec>,
  outcomes: ReadonlyArray<SubagentStartOutcome>,
): SubagentStartContract => {
  const byIndex = new Map(outcomes.map((outcome) => [outcome.index, outcome]));
  const launches = specs.map((spec, index) => projectLaunch(spec, index, byIndex.get(index)));
  const started = launches.filter((launch) => launch.status === "started").length;
  return {
    ...envelope(SUBAGENT_TOOL_NAME.start),
    outcome: batchOutcome(started, launches.length, "started"),
    launches,
  };
};

export interface AwaitContractInput {
  /** Requested-target observations in request order; descendant context never belongs here. */
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  /** Runs whose complete report reached the result; only their owned receipts are consumed. */
  readonly fullyRenderedIds: ReadonlySet<string>;
  readonly until: SubagentAwaitUntil;
  readonly requestedRunIds: ReadonlyArray<string>;
}

export const awaitContract = (input: AwaitContractInput): SubagentAwaitContract => {
  const targets = input.observations.map((observation) =>
    observedTarget(observation, input.fullyRenderedIds),
  );
  return {
    ...envelope(SUBAGENT_TOOL_NAME.await),
    outcome: targets.some((target) => target.parentActionRequired) ? "attention" : "finished",
    until: input.until,
    requestedRunIds: [...input.requestedRunIds],
    targets,
  };
};

export interface CancelledAwaitContractInput {
  /** The latest observation, possibly empty. Report text is never projected from it. */
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly requestedRunIds: ReadonlyArray<string>;
  readonly until: SubagentAwaitUntil;
  /** Whether completion-claim cleanup was confirmed before this receipt was produced. */
  readonly cleanup: "confirmed" | "unconfirmed";
  /** Consumption may have committed before a late abort; do not assert these remain deferred. */
  readonly deliveryAttemptedIds?: ReadonlySet<string>;
}

/** Only the local wait ended: no report is delivered, claimed, or consumed by this receipt. */
export const cancelledAwaitContract = (
  input: CancelledAwaitContractInput,
): SubagentAwaitContract => {
  const observed = new Set(input.runs.map((run) => run.id));
  return {
    ...envelope(SUBAGENT_TOOL_NAME.await),
    outcome: "cancelled",
    until: input.until,
    requestedRunIds: [...input.requestedRunIds],
    targets: input.runs.map((run) => ({
      ...targetFields(run),
      report: input.deliveryAttemptedIds?.has(run.id) ? { status: "unknown" } : withheldReport(run),
    })),
    unobservedRunIds: input.requestedRunIds.filter((id) => !observed.has(id)),
    cleanup: input.cleanup,
  };
};

export interface StatusContractInput {
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  /** Runs whose complete report reached the result; only their owned receipts are consumed. */
  readonly fullyRenderedIds: ReadonlySet<string>;
  readonly missingRunIds: ReadonlyArray<string>;
}

export const statusContract = (input: StatusContractInput): SubagentStatusContract => ({
  ...envelope(SUBAGENT_TOOL_NAME.status),
  targets: input.observations.map((observation) =>
    observedTarget(observation, input.fullyRenderedIds),
  ),
  missingRunIds: [...input.missingRunIds],
});

/** One request-ordered lifecycle target: the returned run view or its typed failure. */
export type LifecycleContractOutcome =
  | { readonly runId: string; readonly run: SubagentRunView }
  | { readonly runId: string; readonly failure: SubagentActionFailure };

/**
 * `requestedRunId` is always the caller's target. For retry, the successor's own `runId` and its
 * `predecessorRunId` stay separate from it. Lifecycle receipts never carry report text.
 */
export const lifecycleContract = (
  action: ContractLifecycleAction,
  outcomes: ReadonlyArray<LifecycleContractOutcome>,
): SubagentLifecycleContract => {
  const results = outcomes.map(
    (outcome): ContractLifecycleResult =>
      "run" in outcome
        ? {
            requestedRunId: outcome.runId,
            status: "succeeded",
            target: withheldTarget(outcome.run),
          }
        : {
            requestedRunId: outcome.runId,
            status: "failed",
            failure: projectFailure(action, outcome.failure),
          },
  );
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  return {
    ...envelope(SUBAGENT_TOOL_NAME.lifecycle),
    action,
    outcome: batchOutcome(succeeded, results.length, "succeeded"),
    results,
  };
};
