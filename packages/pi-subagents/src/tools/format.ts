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
  isActiveRunState,
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  hasUnresolvedSteeringDelivery,
  type SubagentRunView,
  type SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentRunObservation } from "../run/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  formatRunRoute,
  formatSessionActivity,
  formatSessionAge,
  projectRunRoutePresentation,
} from "../ui/run-presentation.ts";
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

/** A proposal's changed-file count with its line totals when known, such as `3 files, +12 −4`. */
export const proposalChangeSummary = (outcome: ProposalDiffStat): string =>
  `${countLabel(outcome.changedFileCount, "file")}${outcome.diffStat ? `, +${outcome.diffStat.addedLines} −${outcome.diffStat.deletedLines}` : ""}`;

/** One line per file the bounded diffstat lists, then how many files it leaves out. */
export const proposalDiffStatLines = (outcome: ProposalDiffStat): ReadonlyArray<string> => {
  const stat = outcome.diffStat;
  if (!stat || stat.files.length === 0) return [];
  const unlisted = outcome.changedFileCount - stat.files.length;
  return [
    ...stat.files.map(
      (file) =>
        `${file.binary ? "binary" : `+${file.addedLines} −${file.deletedLines}`} ${sanitizeTerminalLine(file.path)}`,
    ),
    ...(unlisted > 0 ? [`and ${countLabel(unlisted, "more file")}`] : []),
  ];
};

/** The short outcome of a finished worktree writer's workspace, such as `proposal: 3 files, +12 −4`. */
export const workspaceOutcomeLabel = (outcome: SubagentWorkspaceOutcome): string => {
  if (outcome.status === "auto-discarded") return "workspace discarded: no changes";
  const uncaptured = outcome.uncapturedFileCount
    ? ` (+${outcome.uncapturedFileCount} uncaptured)`
    : "";
  return `proposal: ${proposalChangeSummary(outcome)}${uncaptured}`;
};

/**
 * The one statement of what to do with a worktree writer's proposal, such as
 * `proposal: 3 files, +12 −4 · subagent_workspace apply workspaceId=ws-1`.
 */
export const proposalGuidance = (
  workspaceId: string,
  outcome: SubagentWorkspaceOutcome | undefined,
): string =>
  outcome?.status === "auto-discarded"
    ? workspaceOutcomeLabel(outcome)
    : `${outcome ? workspaceOutcomeLabel(outcome) : "proposal"} · subagent_workspace apply workspaceId=${sanitizeTerminalLine(workspaceId)}`;

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
    "2. Launch a corrected replacement with subagent_start.",
    "3. Await the replacement run ID with subagent_await.",
  ];
};

/** Quarantine evidence only; confirmed or still-settling cleanup needs no mention. */
export const cleanupEvidenceText = (
  run: Pick<AttentionRun, "cleanup" | "writerCleanupQuarantined">,
): string => {
  const cleanup = run.cleanup?.disposition === "quarantined" ? run.cleanup : undefined;
  return [
    cleanup === undefined ? undefined : "Cleanup: quarantined",
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
      : "Cleanup needs recovery; other unfinished subagents continue independently.",
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

/** Options for status and await cards. */
export interface RunFormatOptions {
  /** Adds route selection, context, capabilities, process, cwd, and timing fields. */
  readonly verbose?: boolean | undefined;
  /** The caller's cwd; a compact card names the run's cwd only when it works elsewhere. */
  readonly parentCwd?: string | undefined;
}

/** `local/pi · provider/model:effort` as `pi/provider/model:effort`. */
const runModel = (run: SubagentRunView): string => {
  const { hostRuntime, model } = projectRunRoutePresentation(run);
  return `${hostRuntime.replace(/^local\//u, "")}/${model}`;
};

const runProfileLabel = (run: SubagentRunView): string =>
  run.agent
    ? `${sanitizeTerminalLine(run.agent)} (${sanitizeTerminalLine(run.profile ?? "generalist")})`
    : sanitizeTerminalLine(run.profile ?? "generalist");

const runWorkspaceLabel = (run: SubagentRunView): string | undefined =>
  run.writerWorkspaceMode === "worktree" && run.workspaceId
    ? `worktree ${sanitizeTerminalLine(run.workspaceId)}`
    : run.writeIntent === "writer"
      ? "writer"
      : undefined;

/** One line per run: `id name · profile · runtime/model:effort [· worktree <wsId>]`. */
export const formatStartedRun = (run: SubagentRunView): string =>
  [
    `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)}`,
    runProfileLabel(run),
    runModel(run),
    runWorkspaceLabel(run),
  ]
    .filter(Boolean)
    .join(" · ");

const formatRunHeader = (run: SubagentRunView): string =>
  [
    `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)}`,
    runStateLabel(run.state),
    runProfileLabel(run),
    runModel(run),
    runWorkspaceLabel(run),
    run.depth && run.depth > 1 ? `depth ${run.depth}` : undefined,
    run.descendantCount ? countLabel(run.descendantCount, "descendant") : undefined,
    run.steeringDelivery ? `steeringDelivery=${run.steeringDelivery}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

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

const workspaceStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  const outcome = run.workspaceOutcome;
  if (!run.workspaceId || (!outcome && !isAssignmentFinishedRunState(run.state))) return [];
  const files = outcome?.status === "proposal" ? proposalDiffStatLines(outcome) : [];
  return [
    statusField("Workspace", proposalGuidance(run.workspaceId, outcome)),
    ...files.map((line) => `    ${line}`),
  ];
};

/** Fields every card shows when present: lineage, warnings, failure, and what to do next. */
const compactStatusFields = (
  run: SubagentRunView,
  options: RunFormatOptions,
): ReadonlyArray<string | undefined> => [
  optionalStatusField("Parent", run.parentRunId),
  // A worktree writer's cwd is its private copy of the parent's.
  options.verbose || (run.sourceCwd ?? run.cwd) === options.parentCwd
    ? undefined
    : statusField("Cwd", run.cwd),
  optionalStatusField("Predecessor", run.predecessorRunId),
  optionalStatusField("Superseded by", run.supersededByRunId),
  optionalStatusField("Resumed by", run.resumedBy),
  routeRetryStatus(run),
  optionalStatusField("Route warning", run.selection.warning),
  ...workspaceStatusFields(run),
  cleanupEvidenceText(run) || undefined,
  run.steeringDelivery
    ? statusField(
        "Steering",
        `steeringDelivery=${run.steeringDelivery}. ${steeringDeliveryEvidence[run.steeringDelivery].detail}`,
      )
    : undefined,
  isActiveRunState(run.state) ? optionalStatusField("Current tool", run.currentTool) : undefined,
  isActiveRunState(run.state) ? optionalStatusField("Progress", run.progress) : undefined,
  optionalStatusField("Warning", run.warning),
  run.question ? statusField("Needs reply", run.question.message) : undefined,
  optionalStatusField("Failure", run.error),
];

const verboseStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  const now = synchronousNow();
  const native = run.nativeActivity;
  return [
    run.depth === undefined
      ? undefined
      : statusField(
          "Tree",
          `depth ${run.depth} · ${run.directChildCount ?? 0} direct · ${run.descendantCount ?? 0} descendants`,
        ),
    statusField("Route", formatRunRoute(run)),
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
    ...run.selection.skippedCandidates.map((candidate) =>
      statusField(
        "Skipped",
        `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`} [${candidate.code}]: ${candidate.reason}`,
      ),
    ),
    statusField("Context", run.context),
    statusField("Intent", run.writeIntent),
    optionalStatusField("Workspace mode", run.writerWorkspaceMode),
    statusField("Cwd", run.cwd),
    optionalStatusField("Source cwd", run.sourceCwd),
    statusField(
      "Capabilities",
      `${run.capabilities.join(", ") || "none"}; stop/await always available`,
    ),
    run.pid ? statusField("Process", `pid ${run.pid}`) : undefined,
    optionalStatusField("Elapsed", formatSessionAge(run.endedAt ?? now, run.startedAt)),
    optionalStatusField("Activity", formatSessionActivity(now, run.lastActivityAt)),
    optionalStatusField("Usage", aggregateUsage([run])),
    native
      ? statusField(
          "Native",
          `${native.active} active · ${native.total} total${native.latest ? ` · latest ${native.latest.kind} ${native.latest.state}` : ""}`,
        )
      : undefined,
  ];
};

const finalReportStatus = (run: SubagentRunView): string | undefined => {
  if (run.finalText) return `Final report\n${sanitizeTerminalText(run.finalText)}`;
  if (run.reportStatus === "missing")
    return "Final report\nMissing: no accepted final report for this assignment.";
  if (run.reportStatus === "claimed")
    return "Final report\nClaimed by another operation; report text is withheld here.";
  if (run.reportStatus === "delivered")
    return "Final report\nAlready delivered; report text is withheld here.";
  if (run.state !== "completed") return undefined;
  return "Final report\nAvailability unknown in this observation; report text is not included.";
};

/** A run's status card; without `detailed`, its one-line header. */
export const formatRun = (
  run: SubagentRunView,
  detailed = false,
  options: RunFormatOptions = {},
): string => {
  const header = formatRunHeader(run);
  if (!detailed) return header;
  return [
    header,
    ...compactStatusFields(run, options),
    ...(options.verbose ? verboseStatusFields(run) : []),
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
  options: RunFormatOptions = {},
): DetailedRunsFormat => {
  if (runs.length === 0)
    return { text: prefix || "No subagent runs.", fullyRenderedIds: new Set() };
  const separatorLength = Math.max(0, runs.length - 1) * 2;
  const available = Math.max(0, MAX_TOOL_OUTPUT_CHARS - prefix.length - separatorLength);
  const perRun = Math.max(256, Math.floor(available / runs.length));
  const fullyRenderedIds = new Set<string>();
  const formatted = runs.map((run) => {
    const value = formatRun(run, true, options);
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
  const cleanup = recovery.cleanupDisposition === "quarantined" ? " · cleanup quarantined" : "";
  return `admitted ${sanitizeTerminalLine(recovery.runId)}${cleanup} · retry ${recovery.retryDisposition === "pending" ? "eligible" : recovery.retryDisposition}${remaining}`;
};

export const failedStartRecoveryAction = (recovery: FailedStartRecovery): string => {
  switch (recovery.retryDisposition) {
    case "eligible":
    case "pending":
      return `Continue with subagent_lifecycle({ action: "retry", runIds: [${JSON.stringify(recovery.runId)}] }).`;
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
): string =>
  boundToolOutput(
    [
      ...runs.map((run) =>
        [
          formatStartedRun(run),
          ...(run.selection.warning
            ? [`  Warning: ${boundedLine(run.selection.warning, 512)}`]
            : []),
        ].join("\n"),
      ),
      formatStartFailures(failures),
    ]
      .filter(Boolean)
      .join("\n"),
  );

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
