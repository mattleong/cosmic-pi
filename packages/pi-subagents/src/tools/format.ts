import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { runAttention, runCleanupAttention, type AttentionRun } from "../run/attention.ts";
import {
  sanitizeTerminalLine,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core/security";
import { safeTextPrefix } from "pi-cosmic-core/text";
import { synchronousNow } from "pi-cosmic-core/platform/native-clock";
import { countLabel, clipText } from "pi-cosmic-core/display";
import {
  failedRunNextCandidate,
  isActiveRunState,
  isTerminalRunState,
  isParentActionRequiredRun,
  type SubagentNextCandidate,
  type SubagentRunView,
  type SubagentWorkspaceOutcome,
} from "../run/model.ts";
import {
  MAX_CONTACT_TEXT_CHARS,
  MAX_OUTCOME_FILE_PATH_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
} from "../run/limits.ts";
import { clipWithMarker, failureFileText, MAX_ERROR_CHARS } from "../run/state.ts";
import { distinctRunWarnings } from "../run/warnings.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  formatRunRoute,
  formatSessionActivity,
  formatSessionAge,
  projectRunRoutePresentation,
} from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import {
  actionFailureDisposition,
  NO_ELIGIBLE_ROUTE_CODES,
  noEligibleRouteRecovery,
  unconfirmedActionRecovery,
  type ActionFailureDisposition,
} from "./outcome.ts";
import { isTextFragment } from "./text-fragments.ts";

export const boundToolOutput = (text: string): string =>
  clipWithMarker(
    text,
    MAX_TOOL_OUTPUT_CHARS,
    "\n… [tool output truncated; narrow the request or query individual run IDs for the omitted content]",
  );

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
    ...Arr.map(
      stat.files,
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
  return [
    `Paused run ${runTarget(run)} needs a parent decision.`,
    `1. Review it: agent_read({ agentIds: [${id}] }).`,
    `2. Resume it with guidance: agent_send({ to: ${id}, message: "Continue with the reviewed guidance." }).`,
    `3. Await it again: agent_await({ runIds: [${id}], until: "all_finished" }).`,
  ];
};

/** Quarantine evidence only; confirmed or still-settling cleanup needs no mention. */
export const cleanupEvidenceText = (
  run: Pick<AttentionRun, "cleanup" | "writerCleanupQuarantined">,
): string => {
  const cleanup = run.cleanup?.disposition === "quarantined" ? run.cleanup : undefined;
  return Fn.pipe(
    [
      cleanup === undefined ? undefined : "Cleanup: quarantined",
      cleanup?.diagnostic === undefined
        ? undefined
        : Fn.pipe(
            [
              cleanup.diagnostic.phase,
              cleanup.diagnostic.code === undefined
                ? undefined
                : sanitizeDiagnosticContent(cleanup.diagnostic.code, { maximumLength: 80 }),
              sanitizeDiagnosticContent(cleanup.diagnostic.message, { maximumLength: 1_024 }),
            ],
            Arr.filter(isTextFragment),
            Arr.join(" · "),
          ),
      run.writerCleanupQuarantined === true
        ? "Writer pool is quarantined by unconfirmed cleanup"
        : undefined,
    ],
    Arr.filter(isTextFragment),
    Arr.join("\n"),
  );
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
  const attention = Arr.filter(
    runs,
    (run) => isParentActionRequiredRun(run) || runCleanupAttention(run) !== undefined,
  );
  if (attention.length === 0) return "";
  return Arr.join(
    [
      Arr.some(attention, isParentActionRequiredRun)
        ? "Parent action required; other unfinished subagents continue independently."
        : "Cleanup needs recovery; other unfinished subagents continue independently.",
      ...Arr.flatMap(attention, (run) => {
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
          return Fn.absurd(state);
        })();
        return claim.concat(cleanup);
      }),
    ],
    "\n",
  );
};

/** Bounds each status card field other than its recovery text. */
const MAX_CARD_FIELD_CHARS = 512;
/**
 * Bounds a status card's fields other than its recovery text, together, so the card's header,
 * whole question, failure, and warnings plus these fields fit one tool result.
 */
const MAX_CARD_DETAIL_CHARS = 4_096;

const statusField = (label: string, value: string, maximum = MAX_CARD_FIELD_CHARS): string =>
  `  ${Fn.pipe(label, Str.padEnd(10))} ${clipText(sanitizeTerminalLine(value), maximum)}`;

const optionalStatusField = (
  label: string,
  value: string | undefined,
  maximum?: number,
): string | undefined => (value ? statusField(label, value, maximum) : undefined);

/** Options for status cards. */
export interface RunFormatOptions {
  /** Adds route selection, context, process, cwd, and timing fields. */
  readonly verbose?: boolean | undefined;
  /** The caller's cwd; a compact card names the run's cwd only when it works elsewhere. */
  readonly parentCwd?: string | undefined;
  /** The reader is the run's parent, so the card adds its next steps. */
  readonly readerIsParent?: boolean | undefined;
}

/** `provider/model:effort`, with fast mode and an override marked. */
export const formatRunModel = (run: SubagentRunView): string =>
  projectRunRoutePresentation(run).model;

export const runProfileLabel = (run: Pick<SubagentRunView, "agent" | "profile">): string =>
  run.agent
    ? `${sanitizeTerminalLine(run.agent)} (${sanitizeTerminalLine(run.profile ?? "generalist")})`
    : sanitizeTerminalLine(run.profile ?? "generalist");

const runWorkspaceLabel = (run: SubagentRunView): string | undefined =>
  run.writerWorkspaceMode === "worktree" && run.workspaceId
    ? `worktree ${sanitizeTerminalLine(run.workspaceId)}`
    : run.writeIntent === "writer"
      ? "writer"
      : undefined;

/** One line per run: `id name · profile · provider/model:effort [· worktree <wsId>]`. */
export const formatStartedRun = (run: SubagentRunView): string =>
  Fn.pipe(
    [
      `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)}`,
      runProfileLabel(run),
      formatRunModel(run),
      runWorkspaceLabel(run),
    ],
    Arr.filter(isTextFragment),
    Arr.join(" · "),
  );

const formatRunHeader = (run: SubagentRunView): string =>
  Fn.pipe(
    [
      `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)}`,
      runStateLabel(run.state),
      runProfileLabel(run),
      formatRunModel(run),
      runWorkspaceLabel(run),
      run.depth && run.depth > 1 ? `depth ${run.depth}` : undefined,
      run.descendantCount ? countLabel(run.descendantCount, "descendant") : undefined,
    ],
    Arr.filter(isTextFragment),
    Arr.join(" · "),
  );

/** A route candidate as `model:effort`, without a default effort. */
const candidateLabel = ({ model, effort }: Exclude<SubagentNextCandidate, "none">) =>
  sanitizeTerminalLine(`${model}${effort === "default" ? "" : `:${effort}`}`);

/**
 * Where a failed run's frozen route goes next, such as
 * `openai/gpt-5.5:high; start a new run with that model`.
 */
export const nextCandidateText = (next: SubagentNextCandidate): string =>
  next === "none"
    ? "none; its route has no further candidates"
    : `${candidateLabel(next)}; start a new run with that model`;

const nextCandidateField = (run: SubagentRunView): string | undefined => {
  const next = run.state === "failed" ? failedRunNextCandidate(run) : undefined;
  return next && statusField("Candidate", nextCandidateText(next));
};

/** The parent and what to do next. */
const actionFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => [
  optionalStatusField("Parent", run.parentRunId),
  nextCandidateField(run),
  run.workspaceId && (run.workspaceOutcome || isTerminalRunState(run.state))
    ? statusField("Workspace", proposalGuidance(run.workspaceId, run.workspaceOutcome))
    : undefined,
];

/** Diagnostics every card shows when present, after its actions. */
const compactStatusFields = (
  run: SubagentRunView,
  options: RunFormatOptions,
): ReadonlyArray<string | undefined> => [
  // The proposal's files follow its Workspace action line.
  ...(run.workspaceId && run.workspaceOutcome?.status === "proposal"
    ? Arr.map(proposalDiffStatLines(run.workspaceOutcome), (line) => `    ${line}`)
    : []),
  // A worktree writer's cwd is its private copy of the parent's.
  options.verbose || (run.sourceCwd ?? run.cwd) === options.parentCwd
    ? undefined
    : statusField("Cwd", run.cwd),
  optionalStatusField("Route warning", run.selection.warning),
  cleanupEvidenceText(run) || undefined,
  isActiveRunState(run.state) ? optionalStatusField("Current tool", run.currentTool) : undefined,
  isActiveRunState(run.state) ? optionalStatusField("Progress", run.progress) : undefined,
];

const verboseStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  const now = synchronousNow();
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
          `${run.modelOverride.model}:${run.modelOverride.effort ?? "profile default"}; no fallback candidate`,
        )
      : undefined,
    statusField("Reason", run.selection.reason),
    ...Arr.map(run.selection.skippedCandidates, (candidate) =>
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
    run.pid ? statusField("Process", `pid ${run.pid}`) : undefined,
    optionalStatusField("Elapsed", formatSessionAge(run.endedAt ?? now, run.startedAt)),
    optionalStatusField("Activity", formatSessionActivity(now, run.lastActivityAt)),
    optionalStatusField("Usage", aggregateUsage([run])),
  ];
};

/** A question's indentation stays within this; a question with more lines folds into one. */
const MAX_QUESTION_INDENT_CHARS = 2_048;

/**
 * Indents every line of a child's question, so none can pass for a card field, an action line, or
 * the instructions that follow it.
 */
export const indentQuestionLines = (question: string, indent: string): string => {
  const lines = Str.split(question, /[\n\u2028\u2029]/u);
  if (lines.length * indent.length > MAX_QUESTION_INDENT_CHARS)
    return `${indent}${Arr.join(lines, " ")}`;
  return Fn.pipe(
    lines,
    Arr.map((line) => (line ? `${indent}${line}` : line)),
    Arr.join("\n"),
  );
};

/**
 * A run's full status card, the detail surface that `agent_read` shows: everything multi-run
 * blocks leave out. Its recovery text (the whole pending question, failure, and both retained
 * warnings) leads, and the bounded remaining fields follow, so one run's card always fits a tool
 * result whole. The report follows separately.
 *
 * That bound relies on a question and a failure never being present together: settlement clears
 * the question, and a new assignment clears the failure.
 */
export const formatRunCard = (run: SubagentRunView, options: RunFormatOptions = {}): string => {
  const details = Fn.pipe(
    [
      options.readerIsParent ? attentionRecoveryText([run]) || undefined : undefined,
      ...actionFields(run),
      ...compactStatusFields(run, options),
      ...(options.verbose ? verboseStatusFields(run) : []),
    ],
    Arr.filter(Predicate.isNotUndefined),
    Arr.join("\n"),
  );
  const question = run.question && Str.trim(sanitizeTerminalText(run.question.message));
  const warnings = distinctRunWarnings(run);
  return Fn.pipe(
    [
      clipText(formatRunHeader(run), MAX_CARD_FIELD_CHARS),
      question
        ? `  Needs reply:\n${indentQuestionLines(clipText(question, MAX_CONTACT_TEXT_CHARS), "    ")}`
        : undefined,
      optionalStatusField("Failure", run.error, MAX_ERROR_CHARS),
      optionalStatusField("Warning", warnings.child, MAX_CONTACT_TEXT_CHARS),
      optionalStatusField("System warning", warnings.system, MAX_ERROR_CHARS),
      details && clipWithMarker(details, MAX_CARD_DETAIL_CHARS, "\n  … [more fields omitted]"),
    ],
    Arr.filter(isTextFragment),
    Arr.join("\n"),
  );
};

type FailedStartRecovery = NonNullable<SubagentStartFailure["admittedRun"]>;

export const formatFailedStartRecovery = (recovery: FailedStartRecovery): string =>
  `admitted ${sanitizeTerminalLine(recovery.runId)}${recovery.cleanupDisposition === "quarantined" ? " · cleanup quarantined" : ""}`;

/** The admitted run's next step, which starts with reading it. */
export const failedStartRecoveryAction = (recovery: FailedStartRecovery): string => {
  const runId = sanitizeTerminalLine(recovery.runId);
  return recovery.cleanupDisposition === "quarantined"
    ? `Inspect ${runId} with agent_read before starting a replacement; its cleanup is unconfirmed.`
    : recovery.nextCandidate === undefined || recovery.nextCandidate === "none"
      ? `Review the failure with agent_read ${runId}, then start a new run if the work still needs one.`
      : `Review the failure with agent_read ${runId}, then start a new run with its route's next candidate, ${candidateLabel(recovery.nextCandidate)}.`;
};

/** A failed admitted run's warning on one redacted line, cut with a pointer to the whole one. */
const failedStartWarningLine = (
  recovery: FailedStartRecovery,
  warning: string,
  maximum: number,
): string => {
  const label = "Warning: ";
  const pointer = ` … (cut; agent_read ${sanitizeTerminalLine(recovery.runId)} has the full warning)`;
  const whole = sanitizeDiagnosticError(warning, { maximumLength: Number.MAX_SAFE_INTEGER });
  const room = maximum - label.length;
  return clipText(
    `${label}${whole.length <= room ? whole : `${Str.trimEnd(safeTextPrefix(whole, room - pointer.length))}${pointer}`}`,
    maximum,
  );
};

/** A start result line, such as a started run or a failed launch's recovery step. */
const MAX_START_LINE_CHARS = 320;
/** A failed launch's index, name, code, and message, when no failure file holds the rest. */
const MAX_START_FAILURE_LINE_CHARS = 640;
/** The admitted run's ID and cleanup, or its warning. */
const MAX_START_NOTE_CHARS = 160;
/** A saved failure's path and size. */
const MAX_START_FILE_LINE_CHARS = MAX_OUTCOME_FILE_PATH_CHARS + 112;
/**
 * Each launch of a start batch is a few bounded lines: a started run and its route warning, or a
 * failed launch and its recovery: the admitted run, its saved failure, its warning, and the next
 * step. A failure with a saved file shows only its start, as a notice does. So a full batch
 * always fits the tool output.
 */
export const MAX_START_ENTRY_CHARS = Math.max(
  MAX_START_FAILURE_LINE_CHARS + 2 * MAX_START_NOTE_CHARS + MAX_START_LINE_CHARS + 3,
  2 * MAX_START_LINE_CHARS + 2 * MAX_START_NOTE_CHARS + MAX_START_FILE_LINE_CHARS + 4,
);
/** The `Failed starts (N)` heading. */
export const MAX_START_HEADER_CHARS = 64;

const startLine = (text: string, maximum = MAX_START_LINE_CHARS): string => clipText(text, maximum);

const formatStartFailure = (failure: SubagentStartFailure): string => {
  const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
  const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
  const recovery = failure.admittedRun;
  const file = recovery?.failureFile;
  const noEligibleRoute = NO_ELIGIBLE_ROUTE_CODES.includes(failure.code ?? "");
  return Fn.pipe(
    [
      startLine(
        `  #${failure.index + 1}${target}${code}: ${sanitizeTerminalLine(failure.message)}`,
        file ? MAX_START_LINE_CHARS : MAX_START_FAILURE_LINE_CHARS,
      ),
      recovery
        ? startLine(`    ${formatFailedStartRecovery(recovery)}`, MAX_START_NOTE_CHARS)
        : undefined,
      file ? startLine(`    ${failureFileText(file)}`, MAX_START_FILE_LINE_CHARS) : undefined,
      recovery?.warning
        ? `    ${failedStartWarningLine(recovery, recovery.warning, MAX_START_NOTE_CHARS - 4)}`
        : undefined,
      recovery ? startLine(`    Next: ${failedStartRecoveryAction(recovery)}`) : undefined,
      !recovery && noEligibleRoute ? startLine(`    Next: ${noEligibleRouteRecovery}`) : undefined,
    ],
    Arr.filter(Predicate.isNotUndefined),
    Arr.join("\n"),
  );
};

/** A started run's launch warnings: its route's, then a system one such as a candidate fallback. */
export const startedRunWarning = (
  run: Pick<SubagentRunView, "selection" | "systemWarning">,
): string | undefined => {
  const warning = Arr.join(
    Arr.filter([run.selection.warning ?? "", run.systemWarning ?? ""], Str.isNonEmpty),
    " ",
  );
  return warning || undefined;
};

const formatStartedEntry = (run: SubagentRunView): string => {
  const warning = startedRunWarning(run);
  return Arr.join(
    [
      startLine(formatStartedRun(run)),
      ...(warning ? [startLine(`  Warning: ${sanitizeTerminalLine(warning)}`)] : []),
    ],
    "\n",
  );
};

/** One bounded entry per launch, so every launch of a full batch is listed. */
export const formatStartResult = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): string =>
  Arr.join(
    [
      ...Arr.map(runs, formatStartedEntry),
      ...(failures.length === 0
        ? []
        : [`Failed starts (${failures.length})`, ...Arr.map(failures, formatStartFailure)]),
    ],
    "\n",
  );

/** A lifecycle target's failure: its ID, code, and message on one line. */
export const MAX_ACTION_FAILURE_LINE_CHARS = 400;

const actionFailureLine = (failure: SubagentActionFailure): string => {
  const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
  return clipText(
    `  ${sanitizeTerminalLine(failure.id)}${code}: ${sanitizeTerminalLine(failure.message)}`,
    MAX_ACTION_FAILURE_LINE_CHARS,
  );
};

export const ACTION_FAILURE_SECTIONS = [
  ["unconfirmed", "Unconfirmed targets", unconfirmedActionRecovery],
  ["failed", "Failed targets", undefined],
] as const satisfies ReadonlyArray<readonly [ActionFailureDisposition, string, string | undefined]>;

export const formatActionFailures = (failures: ReadonlyArray<SubagentActionFailure>): string =>
  Fn.pipe(
    ACTION_FAILURE_SECTIONS,
    Arr.flatMap(([disposition, title, guidance]) => {
      const entries = Arr.filter(
        failures,
        (failure) => actionFailureDisposition(failure) === disposition,
      );
      if (entries.length === 0) return [];
      return [
        Arr.join(
          [
            `${title} (${entries.length})`,
            ...Arr.map(entries, actionFailureLine),
            ...(guidance ? [`  ${guidance}`] : []),
          ],
          "\n",
        ),
      ];
    }),
    Arr.join("\n\n"),
  );
