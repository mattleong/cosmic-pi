import { absurd } from "effect/Function";
import { runAttention, runCleanupAttention, type AttentionRun } from "../run/attention.ts";
import {
  sanitizeTerminalLine,
  sanitizeDiagnosticContent,
  stripTerminalControls as sanitizeTerminalText,
  synchronousNow,
  countLabel,
} from "pi-cosmic-core";
import {
  isParentActionRequiredRun,
  hasUnresolvedSteeringDelivery,
  type SubagentRunView,
  type SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentRunObservation } from "../run/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { formatRunRoute, formatSessionActivity, formatSessionAge } from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import type { SubagentToolAction } from "./schema.ts";
import {
  actionFailureDisposition,
  NO_ELIGIBLE_ROUTE_CODES,
  noEligibleRouteRecovery,
  pendingDeliveryEvidence,
  steeringDeliveryEvidence,
  unconfirmedActionRecovery,
  type ActionFailureDisposition,
} from "./outcome.ts";

export const boundToolOutput = (text: string): string =>
  clipWithMarker(
    text,
    MAX_TOOL_OUTPUT_CHARS,
    "\n… [tool output truncated; narrow the request or query individual run IDs for the omitted content]",
  );

export const joinBoundedToolText = (parts: ReadonlyArray<string>): string =>
  boundToolOutput(parts.filter(Boolean).join("\n\n"));

export const boundedLine = (value: string, maximum: number): string =>
  clipWithMarker(sanitizeTerminalLine(value), maximum, "… [truncated]");

const runTarget = (run: AttentionRun): string =>
  `${sanitizeTerminalLine(run.name)} (${sanitizeTerminalLine(run.id)})`;

type ProposalDiffStat = Pick<
  Extract<SubagentWorkspaceOutcome, { readonly status: "proposal" }>,
  "changedFileCount" | "diffStat"
>;

/** A proposal's changed-file count with its line totals when known, such as `3 changed files, +12 -4`. */
export const proposalChangeSummary = (outcome: ProposalDiffStat): string =>
  `${countLabel(outcome.changedFileCount, "changed file")}${outcome.diffStat ? `, +${outcome.diffStat.addedLines} -${outcome.diffStat.deletedLines}` : ""}`;

/** One line per file the bounded diffstat lists, then how many files it leaves out. */
export const proposalDiffStatLines = (outcome: ProposalDiffStat): ReadonlyArray<string> => {
  const stat = outcome.diffStat;
  if (!stat || stat.files.length === 0) return [];
  const unlisted = outcome.changedFileCount - stat.files.length;
  return [
    ...stat.files.map(
      (file) =>
        `${file.binary ? "binary" : `+${file.addedLines} -${file.deletedLines}`} ${sanitizeTerminalLine(file.path)}`,
    ),
    ...(unlisted > 0 ? [`and ${countLabel(unlisted, "more file")}`] : []),
  ];
};

/** The short human outcome of a finished worktree writer's workspace. */
export const workspaceOutcomeLabel = (outcome: SubagentWorkspaceOutcome): string => {
  if (outcome.status === "auto-discarded") return "workspace discarded automatically: no changes";
  const uncaptured = outcome.uncapturedFileCount
    ? ` (+${outcome.uncapturedFileCount} uncaptured)`
    : "";
  return `proposal: ${proposalChangeSummary(outcome)}${uncaptured}; apply or review`;
};

const ordinaryPauseRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  const id = JSON.stringify(run.id);
  if (run.capabilities.includes("resume"))
    return [
      `Paused run ${runTarget(run)} needs a parent decision.`,
      `1. Review it: subagent_status({ runIds: [${id}] }).`,
      `2. Resume it with guidance: subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue with the reviewed guidance." }).`,
      `3. Await it again: subagent_await({ runIds: [${id}], until: "all_finished" }).`,
    ];
  return [
    `Paused run ${runTarget(run)} cannot resume on its backend.`,
    `1. Stop it: subagent_lifecycle({ action: "stop", runIds: [${id}] }).`,
    "2. Launch a corrected replacement with subagent_start after cleanup is confirmed.",
    "3. Await the replacement run ID with subagent_await.",
  ];
};

export const cleanupEvidenceText = (
  run: Pick<AttentionRun, "cleanup" | "writerCleanupQuarantined">,
): string => {
  const cleanup = run.cleanup;
  return [
    cleanup === undefined ? undefined : `Cleanup verification: ${cleanup.disposition}`,
    cleanup?.diagnostic === undefined
      ? undefined
      : [
          cleanup.diagnostic.phase,
          cleanup.diagnostic.code === undefined
            ? undefined
            : sanitizeDiagnosticContent(cleanup.diagnostic.code, { maximumLength: 80 }),
          sanitizeDiagnosticContent(cleanup.diagnostic.message, { maximumLength: 1_024 }),
        ]
          .filter(Boolean)
          .join(" · "),
    run.writerCleanupQuarantined === true
      ? "Writer pool is quarantined by unconfirmed cleanup"
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
};

export const cleanupRecoveryText = (run: AttentionRun): ReadonlyArray<string> => {
  const attention = runCleanupAttention(run);
  if (attention === undefined) return [];
  const evidence = cleanupEvidenceText(run);
  if (attention === "pool-quarantined")
    return [
      `Writer admission for ${runTarget(run)} is blocked by cleanup quarantine.`,
      evidence,
      "List runs with subagent_status and inspect the quarantined run's full status. Recover that run's cleanup; do not stop healthy peers to clear the pool.",
    ];
  if (attention === "pending")
    return [
      `Cleanup verification is pending for ${runTarget(run)}.`,
      evidence,
      "Wait for cleanup verification before retrying or reusing writer resources; terminal task state is not confirmation.",
    ];
  return [
    `Cleanup is unconfirmed for ${runTarget(run)}; its task outcome and accepted report are unchanged.`,
    evidence,
    run.cleanup?.recovery === "stop"
      ? `Request observational cleanup verification with subagent_lifecycle({ action: "stop", runIds: [${JSON.stringify(run.id)}] }). This also stops any active descendants. Only confirmed cleanup releases held resources.`
      : "Manual inspection is required. Cleanup cannot safely be reverified automatically; do not retry, delete leases, or reuse held resources.",
  ];
};

export const attentionRecoveryText = (runs: ReadonlyArray<AttentionRun>): string => {
  const attention = runs.filter(
    (run) => isParentActionRequiredRun(run) || runCleanupAttention(run) !== undefined,
  );
  if (attention.length === 0) return "";
  return [
    attention.some(isParentActionRequiredRun)
      ? "Parent action required; other unfinished subagents continue independently."
      : "Recovery verification is still in progress; other unfinished subagents continue independently.",
    ...attention.flatMap((run) => {
      const state = runAttention(run);
      const cleanup = cleanupRecoveryText(run);
      const claim = ((): ReadonlyArray<string> => {
        switch (state?.kind) {
          case "paused":
            return runCleanupAttention(run) === undefined ? ordinaryPauseRecovery(run) : [];
          case "question":
            return [
              `Question from ${sanitizeTerminalLine(run.name)}: ${boundedLine(state.message, 512)}`,
              `Answer with subagent_send({ runIds: [${JSON.stringify(run.id)}], message: "..." }), then call subagent_await again.`,
            ];
          case "question-unavailable":
          case undefined:
            return [];
        }
        return absurd(state);
      })();
      return claim.concat(cleanup);
    }),
  ].join("\n");
};

const statusField = (label: string, value: string): string =>
  `  ${label.padEnd(10)} ${sanitizeTerminalLine(value)}`;

const optionalStatusField = (label: string, value: string | undefined): string | undefined =>
  value ? statusField(label, value) : undefined;

const formatRunHeader = (run: SubagentRunView, route: string): string => {
  const profile = `${run.agent ? ` · agent=${sanitizeTerminalLine(run.agent)}` : ""}${run.profile ? ` · profile=${sanitizeTerminalLine(run.profile)}` : ""}`;
  const tree = run.depth
    ? ` · depth=${run.depth} · children=${run.directChildCount ?? 0}/${run.descendantCount ?? 0}`
    : "";
  const native = run.nativeActivity
    ? ` · native=${run.nativeActivity.active}/${run.nativeActivity.total}`
    : "";
  const outcome = run.workspaceOutcome ? ` (${workspaceOutcomeLabel(run.workspaceOutcome)})` : "";
  const workspace = run.writerWorkspaceMode
    ? ` · workspace=${run.writerWorkspaceMode}${run.workspaceId ? `:${sanitizeTerminalLine(run.workspaceId)}` : ""}${outcome}`
    : "";
  const steering = run.steeringDelivery ? ` · steeringDelivery=${run.steeringDelivery}` : "";
  return `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)} · ${runStateLabel(run.state)} · ${run.writeIntent}${profile} · ${route}${tree}${native}${workspace}${steering}`;
};

const identityStatusFields = (
  run: SubagentRunView,
  route: string,
): ReadonlyArray<string | undefined> => [
  "Subagent status",
  statusField("Name", run.name),
  statusField("ID", run.id),
  statusField("State", runStateLabel(run.state)),
  optionalStatusField("Parent", run.parentRunId),
  run.depth === undefined
    ? undefined
    : statusField(
        "Tree",
        `depth ${run.depth} · ${run.directChildCount ?? 0} direct · ${run.descendantCount ?? 0} descendants`,
      ),
  optionalStatusField("Agent", run.agent),
  optionalStatusField("Profile", run.profile),
  statusField("Route", route),
  statusField("Retention", `close after report · assignment ${run.reportGeneration || 1}`),
];

const routeRetryStatus = (run: SubagentRunView): string | undefined => {
  if (hasUnresolvedSteeringDelivery(run))
    return statusField(
      "Route retry",
      "blocked by unresolved guidance delivery; do not retry or launch a replacement automatically",
    );
  if (run.retryBlocked)
    return statusField(
      "Route retry",
      "blocked by uncertain execution or cleanup; inspect manually",
    );
  if (run.retryExhausted)
    return statusField("Route retry", "exhausted; only now consider a generalist replacement");
  const remaining = run.remainingCandidateCount ?? 0;
  if (remaining === 0 || run.state !== "failed") return undefined;
  return statusField(
    "Route retry",
    `${remaining} candidate${remaining === 1 ? " remains" : "s remain"}; use subagent_lifecycle action=retry`,
  );
};

const selectionStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => [
  statusField(
    "Selection",
    `${run.selection.source}${run.selection.candidateIndex === undefined ? "" : ` candidate ${run.selection.candidateIndex + 1}`}`,
  ),
  optionalStatusField("Route source", run.selection.routeSource),
  run.modelOverride
    ? statusField(
        "Model override",
        `${run.modelOverride.runtime}/${run.modelOverride.model}:${run.modelOverride.effort ?? "profile default"}; no fallback or retry candidate`,
      )
    : undefined,
  statusField("Reason", run.selection.reason),
  optionalStatusField("Predecessor", run.predecessorRunId),
  optionalStatusField("Superseded by", run.supersededByRunId),
  routeRetryStatus(run),
  ...run.selection.skippedCandidates.map((candidate) =>
    statusField(
      "Skipped",
      `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`} [${candidate.code}]: ${candidate.reason}`,
    ),
  ),
  optionalStatusField("Route warning", run.selection.warning),
];

const workspaceStatusField = (run: SubagentRunView): string | undefined => {
  if (run.workspaceOutcome?.status === "auto-discarded")
    return statusField("Workspace", workspaceOutcomeLabel(run.workspaceOutcome));
  if (!run.workspaceId) return undefined;
  const id = run.workspaceId;
  const outcome = run.workspaceOutcome;
  const files = outcome?.status === "proposal" ? proposalDiffStatLines(outcome) : [];
  return statusField(
    "Proposal",
    `${outcome ? `${workspaceOutcomeLabel(outcome)}. ` : ""}${files.length > 0 ? `Files: ${files.join("; ")}. ` : ""}After process cleanup, apply small or trusted changes with subagent_workspace action=apply workspaceId=${id}; it reports whether the diff was reviewed and tests nothing. For risky changes, review every immutable page, prepare combined changes, run relevant tests in the prepared cwd, then apply the exact revisionId and preparationId. A report does not approve integration.`,
  );
};

const writeStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  return [
    statusField("Context", run.context),
    statusField("Intent", run.writeIntent),
    optionalStatusField("Workspace mode", run.writerWorkspaceMode),
    optionalStatusField("Workspace ID", run.workspaceId),
    statusField("Cwd", run.cwd),
    optionalStatusField("Source cwd", run.sourceCwd),
    workspaceStatusField(run),
    statusField(
      "Capabilities",
      `${run.capabilities.join(", ") || "none"}; stop/await always available`,
    ),
  ];
};

const activityStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  const now = synchronousNow();
  const elapsed = formatSessionAge(run.endedAt ?? now, run.startedAt) || undefined;
  const activity = formatSessionActivity(now, run.lastActivityAt) || undefined;
  const usage = aggregateUsage([run]);
  const native = run.nativeActivity;
  return [
    run.pid ? statusField("Process", `pid ${run.pid}`) : undefined,
    optionalStatusField("Elapsed", elapsed),
    optionalStatusField("Activity", activity),
    optionalStatusField("Usage", usage),
    native
      ? statusField(
          "Native",
          `${native.active} active · ${native.total} total${native.latest ? ` · latest ${native.latest.kind} ${native.latest.state}` : ""}`,
        )
      : undefined,
    run.steeringDelivery
      ? statusField(
          "Steering",
          `steeringDelivery=${run.steeringDelivery}. ${steeringDeliveryEvidence[run.steeringDelivery].detail}`,
        )
      : undefined,
    optionalStatusField("Current tool", run.currentTool),
    optionalStatusField("Progress", run.progress),
    optionalStatusField("Warning", run.warning),
    run.question ? statusField("Needs reply", run.question.message) : undefined,
    optionalStatusField("Failure", run.error),
  ];
};

const finalReportStatus = (run: SubagentRunView): string | undefined => {
  if (run.finalText) return `\nFinal report\n${sanitizeTerminalText(run.finalText)}`;
  if (run.reportStatus === "missing")
    return "\nFinal report\nMissing: no accepted final report for this assignment.";
  if (run.reportStatus === "claimed")
    return "\nFinal report\nClaimed by another operation; report text is withheld here.";
  if (run.reportStatus === "delivered")
    return "\nFinal report\nAlready delivered; report text is withheld here.";
  if (run.state !== "completed") return undefined;
  return "\nFinal report\nAvailability unknown in this observation; report text is not included.";
};

export const formatRun = (run: SubagentRunView, detailed = false): string => {
  const route = formatRunRoute(run);
  const header = formatRunHeader(run, route);
  if (!detailed) return header;
  return [
    ...identityStatusFields(run, route),
    ...selectionStatusFields(run),
    ...writeStatusFields(run),
    cleanupEvidenceText(run) || undefined,
    ...activityStatusFields(run),
    finalReportStatus(run),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

interface DetailedRunsFormat {
  readonly text: string;
  readonly fullyRenderedIds: ReadonlySet<string>;
}

export const formatDetailedRuns = (
  runs: ReadonlyArray<SubagentRunView>,
  prefix = "",
): DetailedRunsFormat => {
  if (runs.length === 0)
    return { text: prefix || "No subagent runs.", fullyRenderedIds: new Set() };
  const separatorLength = Math.max(0, runs.length - 1) * 2;
  const available = Math.max(0, MAX_TOOL_OUTPUT_CHARS - prefix.length - separatorLength);
  const perRun = Math.max(256, Math.floor(available / runs.length));
  const fullyRenderedIds = new Set<string>();
  const formatted = runs.map((run) => {
    const value = formatRun(run, true);
    if (value.length <= perRun) {
      fullyRenderedIds.add(run.id);
      return value;
    }
    return clipWithMarker(value, perRun, "\n… [run output truncated]");
  });
  const output = `${prefix}${formatted.join("\n\n")}`;
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { text: output, fullyRenderedIds };
  return {
    text: clipWithMarker(
      output,
      MAX_TOOL_OUTPUT_CHARS,
      "\n… [additional run output omitted; query individual run IDs]",
    ),
    fullyRenderedIds: new Set(),
  };
};

type FailedStartRecovery = NonNullable<SubagentStartFailure["admittedRun"]>;

export const formatFailedStartRecovery = (recovery: FailedStartRecovery): string => {
  const remaining = recovery.hasRemainingCandidate
    ? ` · ${countLabel(recovery.remainingCandidateCount, "candidate")} remains`
    : " · no candidate remains";
  return `admitted ${sanitizeTerminalLine(recovery.runId)} · cleanup ${recovery.cleanupDisposition} · retry ${recovery.retryDisposition}${remaining}`;
};

export const failedStartRecoveryAction = (recovery: FailedStartRecovery): string => {
  switch (recovery.retryDisposition) {
    case "eligible":
      return `Continue with subagent_lifecycle({ action: "retry", runIds: [${JSON.stringify(recovery.runId)}] }).`;
    case "pending":
      return "Cleanup is still settling; do not retry until an eligible disposition is returned.";
    case "blocked":
      return "Do not retry automatically; ownership or execution outcome is uncertain.";
    case "exhausted":
      return "The frozen profile route is exhausted; only now consider a generalist replacement.";
    case "unavailable":
      return "This run has no frozen route continuation; start a new profiled run if appropriate.";
  }
  return absurd(recovery.retryDisposition);
};

const formatStartFailures = (failures: ReadonlyArray<SubagentStartFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed starts (${failures.length})`,
        ...failures.map((failure) => {
          const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
          const message = boundedLine(failure.message, 2_048);
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          const recovery = failure.admittedRun;
          const noEligibleRoute = NO_ELIGIBLE_ROUTE_CODES.includes(failure.code ?? "");
          return [
            `  #${failure.index + 1}${target}${code}: ${message}`,
            recovery ? `    ${formatFailedStartRecovery(recovery)}` : undefined,
            recovery ? `    Next: ${failedStartRecoveryAction(recovery)}` : undefined,
            !recovery && noEligibleRoute ? `    Next: ${noEligibleRouteRecovery}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n");
        }),
      ].join("\n");

export const formatStartResult = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): string => {
  const failureText = formatStartFailures(failures);
  return formatDetailedRuns(
    runs,
    failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
  ).text;
};

const actionFailureLine = (failure: SubagentActionFailure): string => {
  const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
  return `  ${sanitizeTerminalLine(failure.id)}${code}: ${boundedLine(failure.message, 320)}`;
};

export const ACTION_FAILURE_SECTIONS = [
  ["pending", "Guidance awaiting confirmation", pendingDeliveryEvidence.detail],
  ["unconfirmed", "Unconfirmed targets", unconfirmedActionRecovery],
  ["failed", "Failed targets", undefined],
] as const satisfies ReadonlyArray<readonly [ActionFailureDisposition, string, string | undefined]>;

export const formatActionFailures = (
  action: SubagentToolAction,
  failures: ReadonlyArray<SubagentActionFailure>,
): string =>
  ACTION_FAILURE_SECTIONS.flatMap(([disposition, title, guidance]) => {
    const entries = failures.filter(
      (failure) => actionFailureDisposition(action, failure) === disposition,
    );
    if (entries.length === 0) return [];
    return [
      [
        `${title} (${entries.length})`,
        ...entries.map(actionFailureLine),
        ...(guidance ? [`  ${guidance}`] : []),
      ].join("\n"),
    ];
  }).join("\n\n");

export const renderedCompletionReceipts = (
  observations: ReadonlyArray<SubagentRunObservation>,
  fullyRenderedIds: ReadonlySet<string>,
) =>
  observations.flatMap((observation) =>
    observation.completionReceipt && fullyRenderedIds.has(observation.run.id)
      ? [observation.completionReceipt]
      : [],
  );
