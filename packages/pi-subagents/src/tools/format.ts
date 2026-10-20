import { absurd } from "effect/Function";
import * as Predicate from "effect/Predicate";
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
  isTerminalRunState,
  isParentActionRequiredRun,
  hasUnresolvedSteeringDelivery,
  type SubagentRunView,
  type SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentRunObservation } from "../run/service.ts";
import { clipWithMarker, reportFileText, unsavedReportNote } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  formatRunRoute,
  formatSessionActivity,
  formatSessionAge,
  projectRunRoutePresentation,
} from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { projectReportFile } from "./details-projection.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import {
  actionFailureDisposition,
  NO_ELIGIBLE_ROUTE_CODES,
  noEligibleRouteRecovery,
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

const RESOLVED_WORKSPACE_LABELS = {
  "auto-discarded": "workspace discarded: no changes",
  integrated: "workspace applied",
  discarded: "workspace discarded",
} as const;

/** The short outcome of a finished worktree writer's workspace, such as `proposal: 3 files, +12 −4`. */
export const workspaceOutcomeLabel = (outcome: SubagentWorkspaceOutcome): string => {
  if (outcome.status !== "proposal") return RESOLVED_WORKSPACE_LABELS[outcome.status];
  const uncaptured = outcome.uncapturedFileCount
    ? ` (+${outcome.uncapturedFileCount} uncaptured)`
    : "";
  return `proposal: ${proposalChangeSummary(outcome)}${uncaptured}`;
};

/**
 * The one statement of what to do with a worktree writer's proposal, such as
 * `proposal: 3 files, +12 −4 · agent_worktree apply workspaceId=ws-1`.
 */
export const proposalGuidance = (
  workspaceId: string,
  outcome: SubagentWorkspaceOutcome | undefined,
): string =>
  outcome !== undefined && outcome.status !== "proposal"
    ? workspaceOutcomeLabel(outcome)
    : `${outcome ? workspaceOutcomeLabel(outcome) : "proposal"} · agent_worktree apply workspaceId=${sanitizeTerminalLine(workspaceId)}`;

const ordinaryPauseRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  const id = JSON.stringify(run.id);
  if (run.capabilities.includes("resume"))
    return [
      `Paused run ${runTarget(run)} needs a parent decision.`,
      `1. Review it: agent_read({ agentIds: [${id}] }).`,
      `2. Resume it with guidance: agent_send({ to: ${id}, message: "Continue with the reviewed guidance." }).`,
      `3. Await it again: agent_await({ runIds: [${id}], until: "all_finished" }).`,
    ];
  return [
    `Paused run ${runTarget(run)} cannot resume on its backend.`,
    `1. Stop it: agent_lifecycle({ action: "stop", runIds: [${id}] }).`,
    "2. Launch a corrected replacement with agent_start.",
    "3. Await the replacement run ID with agent_await.",
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
      "List runs with agent_list and inspect the quarantined run with agent_read. Recover that run's cleanup; do not stop healthy peers to clear the pool.",
    ];
  return [
    `Cleanup is unconfirmed for ${runTarget(run)}; its task outcome and accepted report are unchanged.`,
    evidence,
    run.cleanup?.recovery === "stop"
      ? `Request observational cleanup verification with agent_lifecycle({ action: "stop", runIds: [${JSON.stringify(run.id)}] }). This also stops any active descendants. Only confirmed cleanup releases held resources.`
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
              `Answer with agent_send({ to: ${JSON.stringify(run.id)}, message: "..." }), then call agent_await again.`,
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
  /** Ends the card with the final report's text or availability; on by default. */
  readonly report?: boolean | undefined;
}

/** `local/pi · provider/model:effort` as `pi/provider/model:effort`. */
export const formatRunModel = (run: SubagentRunView): string => {
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
    formatRunModel(run),
    runWorkspaceLabel(run),
  ]
    .filter(Boolean)
    .join(" · ");

const formatRunHeader = (run: SubagentRunView): string =>
  [
    `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)}`,
    runStateLabel(run.state),
    runProfileLabel(run),
    formatRunModel(run),
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
    `${remaining} candidate${remaining === 1 ? " remains" : "s remain"}; use agent_lifecycle action=retry`,
  );
};

/** Lineage and what to do next, which a card never clips. */
const actionFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => [
  optionalStatusField("Parent", run.parentRunId),
  optionalStatusField("Predecessor", run.predecessorRunId),
  optionalStatusField("Superseded by", run.supersededByRunId),
  optionalStatusField("Resumed by", run.resumedBy),
  routeRetryStatus(run),
  run.steeringDelivery
    ? statusField(
        "Steering",
        `steeringDelivery=${run.steeringDelivery}. ${steeringDeliveryEvidence[run.steeringDelivery].detail}`,
      )
    : undefined,
  run.workspaceId && (run.workspaceOutcome || isTerminalRunState(run.state))
    ? statusField("Workspace", proposalGuidance(run.workspaceId, run.workspaceOutcome))
    : undefined,
];

/** Diagnostics every card shows when present, after its actions; these may be clipped. */
const compactStatusFields = (
  run: SubagentRunView,
  options: RunFormatOptions,
): ReadonlyArray<string | undefined> => [
  // The proposal's files follow its Workspace action line.
  ...(run.workspaceId && run.workspaceOutcome?.status === "proposal"
    ? proposalDiffStatLines(run.workspaceOutcome).map((line) => `    ${line}`)
    : []),
  // A worktree writer's cwd is its private copy of the parent's.
  options.verbose || (run.sourceCwd ?? run.cwd) === options.parentCwd
    ? undefined
    : statusField("Cwd", run.cwd),
  optionalStatusField("Route warning", run.selection.warning),
  cleanupEvidenceText(run) || undefined,
  isActiveRunState(run.state) ? optionalStatusField("Current tool", run.currentTool) : undefined,
  isActiveRunState(run.state) ? optionalStatusField("Progress", run.progress) : undefined,
  optionalStatusField("Warning", run.warning),
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

/** A saved report is a pointer to its file; only a report without one is inlined. */
const finalReportStatus = (run: SubagentRunView): string | undefined => {
  const reportFile = projectReportFile(run.reportArchive);
  if (run.finalText)
    return reportFile
      ? `Final report\n${reportFileText(reportFile)}`
      : `Final report\n${unsavedReportNote(run.finalTextTruncation)}\n${sanitizeTerminalText(run.finalText)}`;
  if (run.reportStatus === "missing")
    return "Final report\nMissing: no accepted final report for this assignment.";
  if (run.reportStatus === "claimed")
    return "Final report\nClaimed by another operation; report text is withheld here.";
  if (run.reportStatus === "delivered")
    return "Final report\nAlready delivered; report text is withheld here. agent_read gives its file, or the report when none was saved.";
  if (run.state !== "completed") return undefined;
  return "Final report\nAvailability unknown in this observation; report text is not included.";
};

interface RunCard {
  /** The header, lineage, and what to do next, which a card always shows. */
  readonly head: string;
  /** Diagnostics and verbose fields, which may be clipped. */
  readonly status: string | undefined;
  /** The pending question, failure, and report, which a card shows whole or not at all. */
  readonly outcome: string | undefined;
}

const joinLines = (lines: ReadonlyArray<string | undefined>): string | undefined => {
  const present = lines.filter(Predicate.isNotUndefined);
  return present.length > 0 ? present.join("\n") : undefined;
};

const runCard = (run: SubagentRunView, options: RunFormatOptions): RunCard => ({
  head: [formatRunHeader(run), ...actionFields(run)].filter(Predicate.isNotUndefined).join("\n"),
  status: joinLines([
    ...compactStatusFields(run, options),
    ...(options.verbose ? verboseStatusFields(run) : []),
  ]),
  outcome: joinLines([
    run.question ? statusField("Needs reply", run.question.message) : undefined,
    optionalStatusField("Failure", run.error),
    options.report === false ? undefined : finalReportStatus(run),
  ]),
});

const joinRunCard = ({ head, status, outcome }: RunCard): string =>
  [head, status, outcome].filter(Predicate.isNotUndefined).join("\n");

/** A run's status card; without `detailed`, its one-line header. */
export const formatRun = (
  run: SubagentRunView,
  detailed = false,
  options: RunFormatOptions = {},
): string => (detailed ? joinRunCard(runCard(run, options)) : formatRunHeader(run));

interface DetailedRunsFormat {
  readonly text: string;
  /** Runs whose pending question, failure, and report appear whole, so they count as delivered. */
  readonly deliveredIds: ReadonlySet<string>;
}

/** The room each card's clippable status keeps, even when outcomes fill the rest. */
const MIN_CARD_STATUS_CHARS = 256;
const CLIPPED_STATUS_MARKER = "\n… [status truncated; agent_read shows this run's full status]";
const DEFERRED_OUTCOME_LINE =
  "… [question, failure, or report withheld to fit this result; call agent_await again for it]";

/**
 * Cards bounded to the tool output. Outcomes of `pendingIds`, the runs holding an undelivered
 * completion or question, are reserved first, then every other run's, so neither diagnostics nor
 * already-delivered outcomes can withhold them. An outcome that doesn't fit is replaced by a
 * fixed deferral line and leaves its run undelivered for a later await.
 */
export const formatDetailedRuns = (
  runs: ReadonlyArray<SubagentRunView>,
  prefix = "",
  options: RunFormatOptions = {},
  pendingIds: ReadonlySet<string> = new Set(),
): DetailedRunsFormat => {
  if (runs.length === 0) return { text: prefix || "No subagent runs.", deliveredIds: new Set() };
  const cards = runs.map((run) => ({ id: run.id, card: runCard(run, options) }));
  let room =
    MAX_TOOL_OUTPUT_CHARS -
    prefix.length -
    (runs.length - 1) * 2 -
    cards.reduce((total, { card }) => total + card.head.length + 1 + MIN_CARD_STATUS_CHARS, 0);
  const kept = new Set<string>();
  const reserve = ({ id, card }: (typeof cards)[number]) => {
    const length = card.outcome === undefined ? 0 : card.outcome.length + 1;
    if (length > room) return;
    room -= length;
    kept.add(id);
  };
  cards.filter(({ id }) => pendingIds.has(id)).forEach(reserve);
  cards.filter(({ id }) => !pendingIds.has(id)).forEach(reserve);
  const perRun = MIN_CARD_STATUS_CHARS + Math.max(0, Math.floor(room / runs.length));
  const formatted = cards.map(({ id, card }) => {
    const deferred = card.outcome !== undefined && !kept.has(id);
    const statusRoom = deferred ? perRun - DEFERRED_OUTCOME_LINE.length - 1 : perRun;
    return joinRunCard({
      head: card.head,
      status:
        card.status === undefined
          ? undefined
          : clipWithMarker(card.status, statusRoom, CLIPPED_STATUS_MARKER),
      outcome: deferred ? DEFERRED_OUTCOME_LINE : card.outcome,
    });
  });
  const output = `${prefix}${formatted.join("\n\n")}`;
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { text: output, deliveredIds: kept };
  return {
    text: clipWithMarker(
      output,
      MAX_TOOL_OUTPUT_CHARS,
      "\n… [additional run output omitted; query individual run IDs]",
    ),
    deliveredIds: new Set(),
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
      return `Continue with agent_lifecycle({ action: "retry", runIds: [${JSON.stringify(recovery.runId)}] }).`;
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
  ["unconfirmed", "Unconfirmed targets", unconfirmedActionRecovery],
  ["failed", "Failed targets", undefined],
] as const satisfies ReadonlyArray<readonly [ActionFailureDisposition, string, string | undefined]>;

export const formatActionFailures = (failures: ReadonlyArray<SubagentActionFailure>): string =>
  ACTION_FAILURE_SECTIONS.flatMap(([disposition, title, guidance]) => {
    const entries = failures.filter((failure) => actionFailureDisposition(failure) === disposition);
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
  deliveredIds: ReadonlySet<string>,
) =>
  observations.flatMap((observation) =>
    observation.completionReceipt && deliveredIds.has(observation.run.id)
      ? [observation.completionReceipt]
      : [],
  );
