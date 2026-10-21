import { isCustomAgentName } from "../profiles/agents.ts";
import {
  safeTextPrefix,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import {
  isTerminalRunState,
  isParentActionRequiredRun,
  type FailedStartRecovery,
  type SubagentRunView,
} from "../run/model.ts";
import type { SubagentAwaitUntil, SubagentRunObservation } from "../run/service.ts";
import { MAX_NAME_CHARS, sanitizeName } from "../run/state.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { runAttention } from "../run/attention.ts";
import { MAX_CONTACT_TEXT_CHARS } from "../run/limits.ts";
import { distinctRunWarnings } from "../run/warnings.ts";
import {
  MAX_CONTRACT_MESSAGE_CHARS,
  MAX_CONTRACT_PREVIEW_CHARS,
  type ContractAttention,
  type ContractFailure,
  type ContractLifecycleAction,
  type ContractLifecycleResult,
  type ContractReadStatus,
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
} from "./contract-schema.ts";
import {
  nonNegativeInteger,
  projectModelOverride,
  projectReportFile,
  projectRunCleanup,
} from "./details-projection.ts";
import { MAX_FAILURE_CODE_CHARS } from "./details-schema.ts";
import type { SubagentActionFailure, SubagentStartFailure, SubagentStartOutcome } from "./model.ts";
import { actionFailureDisposition } from "./outcome.ts";
import type { SubagentStartSpec } from "./schema.ts";

export const envelope = <Tool extends SubagentContractTool>(tool: Tool) => ({ tool }) as const;

const batchOutcome = <Success extends string>(succeeded: number, total: number, success: Success) =>
  succeeded === 0 ? ("failed" as const) : succeeded === total ? success : ("partial" as const);

export const metadata = (value: string | undefined, maximum: number): string | undefined => {
  const line = value === undefined ? "" : sanitizeTerminalLine(value);
  return line ? sanitizeDiagnosticError(line, { maximumLength: maximum }) : undefined;
};

export const projectName = (value: string): string =>
  sanitizeName(metadata(value, MAX_NAME_CHARS) ?? "");

const knownProfile = (profile: string | undefined): ProfileId | undefined =>
  PROFILE_IDS.find((id) => id === profile);

const knownAgent = (agent: string | undefined): { readonly agent?: string } =>
  agent !== undefined && isCustomAgentName(agent) ? { agent } : {};

const hasId = (id: string | undefined): id is string => id !== undefined && id.length > 0;

const projectRecovery = (recovery: FailedStartRecovery): ContractRecovery => ({
  cleanup: recovery.cleanupDisposition,
  disposition: recovery.retryDisposition,
  remainingCandidateCount: nonNegativeInteger(recovery.remainingCandidateCount),
});

const projectFailure = (
  failure: Pick<SubagentActionFailure, "code" | "message">,
): ContractFailure => {
  const code = metadata(failure.code, MAX_FAILURE_CODE_CHARS);
  return {
    disposition: actionFailureDisposition(failure),
    ...(code !== undefined && { code }),
    message: metadata(failure.message, MAX_CONTRACT_MESSAGE_CHARS) ?? "Action failed.",
  };
};

/** A question's preview, or with `questionChars` its whole retained text. */
export const projectAttention = (
  run: SubagentRunView,
  questionChars = MAX_CONTRACT_PREVIEW_CHARS,
): ContractAttention | undefined => {
  const attention = runAttention(run);
  if (attention?.kind !== "question") return attention;
  const message = sanitizeDiagnosticContent(stripTerminalControls(attention.message), {
    maximumLength: questionChars,
  }).trim();
  return message ? { kind: "question", message } : { kind: "question-unavailable" };
};

/** The retained child and system warnings. */
const projectWarnings = (run: SubagentRunView, chars: number): ContractRunTarget["warnings"] => {
  const warnings = distinctRunWarnings(run);
  return (
    [
      ["child", warnings.child],
      ["system", warnings.system],
    ] as const
  ).flatMap(([source, warning]) => {
    const message = metadata(warning, chars);
    return message === undefined ? [] : [{ source, message }];
  });
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

const withheldReport = (run: SubagentRunView): ContractWithheldReport => ({
  status: !isTerminalRunState(run.state)
    ? "not_finished"
    : run.reportStatus === undefined
      ? "unknown"
      : WITHHELD_REPORT_STATUS[run.reportStatus],
});

/** Every claimed report an await observes is delivered: its result always shows the outcome. */
const observedReport = ({ run, completionReceipt }: SubagentRunObservation): ContractReport => {
  if (!isTerminalRunState(run.state)) return { status: "not_finished" };
  if (completionReceipt === undefined) return withheldReport(run);
  const text = stripTerminalControls(run.finalText ?? "");
  if (!text.trim()) return { status: "missing" };
  const file = projectReportFile(run.reportArchive);
  return file
    ? { status: "delivered", ...file }
    : {
        status: "delivered",
        text: safeTextPrefix(text, MAX_CONTRACT_PREVIEW_CHARS),
        truncated:
          run.finalTextTruncation !== undefined || text.length > MAX_CONTRACT_PREVIEW_CHARS,
      };
};

/** `detailChars` bounds the question, warnings, and error: previews, or a read's whole text. */
const targetFields = (
  run: SubagentRunView,
  recovery?: FailedStartRecovery,
  detailChars = MAX_CONTRACT_PREVIEW_CHARS,
): Omit<ContractRunTarget, "report"> => {
  const profile = knownProfile(run.profile);
  const attention = projectAttention(run, detailChars);
  const error = metadata(run.error, detailChars);
  const errorFile = error === undefined ? undefined : projectReportFile(run.errorArchive);
  return {
    ...(run.writerCleanupQuarantined !== undefined && {
      writerCleanupQuarantined: run.writerCleanupQuarantined,
    }),
    runId: run.id,
    name: projectName(run.name) || "subagent",
    ...(profile !== undefined && { profile }),
    ...knownAgent(run.agent),
    state: run.state,
    finished: isTerminalRunState(run.state),
    writeIntent: run.writeIntent,
    ...projectModelOverride(run.modelOverride),
    ...(hasId(run.predecessorRunId) && { predecessorRunId: run.predecessorRunId }),
    ...(hasId(run.supersededByRunId) && { successorRunId: run.supersededByRunId }),
    parentActionRequired: isParentActionRequiredRun(run),
    ...(attention !== undefined && { attention }),
    ...(recovery?.runId === run.id && { retry: projectRecovery(recovery) }),
    warnings: projectWarnings(run, detailChars),
    ...(error !== undefined && { error }),
    ...(errorFile !== undefined && { errorFile }),
  };
};

const withheldTarget = (run: SubagentRunView): ContractWithheldRunTarget => ({
  ...targetFields(run),
  report: withheldReport(run),
});

/**
 * A read's status, the detail surface, which carries the whole pending question, both retained
 * warnings, the error, the run's capabilities, and cleanup diagnostics.
 */
export const readStatusTarget = (run: SubagentRunView): ContractReadStatus => {
  const cleanup = projectRunCleanup(run.cleanup);
  return {
    ...targetFields(run, undefined, MAX_CONTACT_TEXT_CHARS),
    report: withheldReport(run),
    capabilities: [...new Set(run.capabilities)],
    ...(cleanup !== undefined && { cleanup }),
  };
};

const observedTarget = (observation: SubagentRunObservation): ContractRunTarget => ({
  ...targetFields(observation.run, observation.recovery),
  report: observedReport(observation),
});

const UNOBSERVED_LAUNCH: SubagentStartFailure = {
  index: -1,
  code: "launch_outcome_uncertain",
  message: "Launch outcome was not observed.",
};

const startedLaunch = (
  spec: SubagentStartSpec,
  index: number,
  run: SubagentRunView,
): ContractStartLaunch => {
  const profile = knownProfile(run.profile ?? spec.profile);
  return {
    index,
    status: "started",
    runId: run.id,
    name: projectName(run.name) || projectName(spec.name ?? "") || `launch ${index + 1}`,
    ...(profile !== undefined && { profile }),
    ...knownAgent(run.agent ?? spec.agent),
    state: run.state,
    writeIntent: run.writeIntent,
    ...projectModelOverride(run.modelOverride),
  };
};

const failedLaunch = (
  spec: SubagentStartSpec,
  index: number,
  outcome: Extract<SubagentStartOutcome, { readonly failure: unknown }> | undefined,
): ContractStartLaunch => {
  const failure = outcome?.failure ?? UNOBSERVED_LAUNCH;
  const name = projectName(spec.name ?? "");
  const profile = knownProfile(outcome?.resolvedRoute?.profile ?? spec.profile);
  const admitted = failure.admittedRun;
  return {
    index,
    status: "failed",
    ...(name && { name }),
    ...(profile !== undefined && { profile }),
    ...knownAgent(outcome?.resolvedRoute?.agent ?? spec.agent),
    failure: projectFailure(failure),
    ...(admitted !== undefined && {
      admittedRun: { runId: admitted.runId, ...projectRecovery(admitted) },
    }),
  };
};

const projectLaunch = (
  spec: SubagentStartSpec,
  index: number,
  outcome: SubagentStartOutcome | undefined,
): ContractStartLaunch =>
  outcome !== undefined && "run" in outcome
    ? startedLaunch(spec, index, outcome.run)
    : failedLaunch(spec, index, outcome);

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

interface AwaitContractInput {
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  readonly until: SubagentAwaitUntil;
  readonly requestedRunIds: ReadonlyArray<string>;
  /** Another run that the caller did not await asked it a question. */
  readonly questionsElsewhere?: boolean | undefined;
}

export const awaitContract = (input: AwaitContractInput): SubagentAwaitContract => {
  const targets = input.observations.map(observedTarget);
  return {
    ...envelope(SUBAGENT_TOOL_NAME.await),
    outcome:
      input.questionsElsewhere === true || targets.some((target) => target.parentActionRequired)
        ? "attention"
        : "finished",
    until: input.until,
    requestedRunIds: [...input.requestedRunIds],
    targets,
  };
};

interface CancelledAwaitContractInput {
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly requestedRunIds: ReadonlyArray<string>;
  readonly until: SubagentAwaitUntil;
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly deliveryAttemptedIds?: ReadonlySet<string>;
  readonly ending?: "cancelled" | "timed_out" | "user_input" | undefined;
}

export const cancelledAwaitContract = (
  input: CancelledAwaitContractInput,
): SubagentAwaitContract => {
  const observed = new Set(input.runs.map((run) => run.id));
  return {
    ...envelope(SUBAGENT_TOOL_NAME.await),
    outcome: input.ending ?? "cancelled",
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

type LifecycleContractOutcome =
  | { readonly runId: string; readonly run: SubagentRunView }
  | { readonly runId: string; readonly failure: SubagentActionFailure };

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
            failure: projectFailure(outcome.failure),
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
