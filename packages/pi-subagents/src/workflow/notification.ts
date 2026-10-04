import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { clipText } from "pi-cosmic-core";
import {
  sanitizeNotificationContent,
  type SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";
import type { WorkflowInterruptedRun } from "./journal.ts";
import {
  countWorkflowRunAgents,
  WORKFLOW_NOTIFICATION_MAX_CHARS,
  WORKFLOW_RESULT_MAX_CHARS,
  workflowAgentTotal,
  workflowWorkspaces,
  type WorkflowLogEntry,
  type WorkflowResult,
  type WorkflowRunView,
} from "./model.ts";
import {
  clipWorkflowText,
  WORKFLOW_LOG_LINE_MAX_CHARS,
  WORKFLOW_WORKSPACE_LINES,
  WORKFLOW_WORKSPACES_TITLE,
  workflowBudgetLine,
  workflowExtendLine,
  workflowFailureSection,
  workflowFinishedAgentsLine,
  workflowJournalLine,
  workflowLogLine,
  workflowOutcomeHeadline,
  workflowRestart,
  workflowResultSection,
  workflowRunSubject,
  workflowUsageLine,
  workflowWarningsSection,
  workflowWorkspaceLines,
  workflowWorkspacesSection,
} from "./run-text.ts";

/** Log lines a notification repeats: every level for failed or stopped runs, warnings otherwise. */
const NOTIFICATION_LOG_LINES = 12;
/** Room kept for the saved file's path in a clipped result's header. */
const RESULT_PATH_RESERVE = 1024;
/** Fitting stops once the largest clip window that fits is known to within this many characters. */
const RESULT_FIT_PRECISION = 64;

/** The script's value as the main agent reads it: strings verbatim, anything else as JSON. */
export const workflowValueText = (value: Schema.Json): string =>
  Predicate.isString(value) ? value : JSON.stringify(value, null, 2);

/** Redacted before it is bounded, so redaction can't lengthen a section past its bound. */
const boundedText = (text: string, maximum: number): string =>
  clipWorkflowText(sanitizeNotificationContent(text), maximum);

const logLine = (entry: WorkflowLogEntry): string =>
  workflowLogLine(entry, (message) =>
    clipText(sanitizeNotificationContent(message), WORKFLOW_LOG_LINE_MAX_CHARS),
  );

const logSection = (title: string, entries: ReadonlyArray<WorkflowLogEntry>): string | undefined =>
  entries.length === 0
    ? undefined
    : [title, ...entries.slice(-NOTIFICATION_LOG_LINES).map(logLine)].join("\n");

/** Sections in order; a completed run's result comes last, sized to the room left for it. */
const sections = (run: WorkflowRunView): ReadonlyArray<string | undefined> => {
  const frame = [
    workflowOutcomeHeadline(run),
    [
      workflowFinishedAgentsLine(run),
      workflowUsageLine(run, run.endedAt ?? run.startedAt),
      workflowBudgetLine(run),
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    run.journalPath === undefined ? undefined : workflowJournalLine(run.journalPath),
    workflowWorkspacesSection(run, WORKFLOW_WORKSPACES_TITLE, WORKFLOW_WORKSPACE_LINES),
  ];
  if (run.state === "completed")
    return [
      ...frame,
      // Warnings explain null results, such as agents that failed or items that threw.
      workflowWarningsSection(run, NOTIFICATION_LOG_LINES, logLine),
      workflowExtendLine(run),
      run.result ? workflowResultSection(run.result) : "Result: null",
    ];
  if (run.state === "failed")
    return [
      ...frame,
      workflowFailureSection(run, boundedText).join("\n\n"),
      logSection("Recent log:", run.logs),
    ];
  // Someone chose to stop it; nothing suggests running it again.
  return [...frame, logSection("Recent log:", run.logs)];
};

/** Redacted as the host redacts it, so its length is the length the host clips. */
const content = (run: WorkflowRunView): string =>
  sanitizeNotificationContent(
    sections(run)
      .filter((section): section is string => section !== undefined)
      .join("\n\n"),
  );

/** Notification length with `text` as a clipped result, leaving room for the file's path. */
const clippedLength = (run: WorkflowRunView, text: string): number =>
  content({ ...run, result: { text, clipped: true, path: "" } }).length + RESULT_PATH_RESERVE;

/**
 * Characters a finished run's result may use: what the notification's other sections leave,
 * at most {@link WORKFLOW_RESULT_MAX_CHARS}. A longer result is clipped and saved to a file.
 */
export const workflowResultBudget = (run: WorkflowRunView): number =>
  Math.max(
    0,
    Math.min(WORKFLOW_RESULT_MAX_CHARS, WORKFLOW_NOTIFICATION_MAX_CHARS - clippedLength(run, "")),
  );

/**
 * A finished run's result text as its notification carries it: verbatim when the redacted
 * notification fits, otherwise clipped to about the largest head and tail that fit with room for
 * the saved file's path. Redaction can lengthen text, so fitting measures the redacted
 * notification, not the raw text.
 */
export const fitWorkflowResult = (run: WorkflowRunView, text: string): WorkflowResult => {
  if (
    text.length <= WORKFLOW_RESULT_MAX_CHARS &&
    content({ ...run, result: { text, clipped: false } }).length <= WORKFLOW_NOTIFICATION_MAX_CHARS
  )
    return { text, clipped: false };
  const fits = (maximum: number) =>
    clippedLength(run, clipWorkflowText(text, maximum)) <= WORKFLOW_NOTIFICATION_MAX_CHARS;
  // Redaction can grow a window by any ratio, so search for the largest window that fits.
  let low = 0;
  let high = workflowResultBudget(run);
  if (fits(high)) return { text: clipWorkflowText(text, high), clipped: true };
  while (high - low > RESULT_FIT_PRECISION) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  // When even a small window doesn't fit, only the clip marker is left; the file holds the value.
  return { text: clipWorkflowText(text, low), clipped: true };
};

/**
 * The single notification a finished run delivers, or undefined while it still runs or when the
 * main agent stopped it: the stop's own result already carries the final state.
 */
export const workflowNotification = (
  run: WorkflowRunView,
): SubagentWorkflowNotification | undefined => {
  const outcome = run.state;
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "stopped") return undefined;
  if (run.stoppedBy === "tool") return undefined;
  const counts = countWorkflowRunAgents(run);
  return {
    type: "workflow",
    runId: run.id,
    name: run.name,
    outcome,
    durationMs: Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt),
    usage: {
      totalTokens: run.usage.totalTokens,
      // A cost some agents didn't report is a lower bound, which the compact row leaves out.
      ...(run.usage.cost !== undefined && run.usage.unpriced === 0 && { cost: run.usage.cost }),
    },
    content: content(run),
    agents: {
      total: workflowAgentTotal(run),
      failed: counts.failed,
      stopped: counts.stopped,
      skipped: counts.skipped,
      reused: run.reused,
    },
    workspaces: workflowWorkspaces(run).map((workspace) => workspace.workspaceId),
  };
};

/** What ended the run: a teardown this process remembers, or anything before Pi restarted. */
const interruptedCause = (run: WorkflowInterruptedRun): string =>
  run.restarted ? "before Pi restarted" : "when the session was reloaded, navigated or replaced";

/** What came before Pi accepted an ended run's report. */
const undeliveredCause = (run: WorkflowInterruptedRun): string =>
  run.restarted ? "before Pi restarted" : "before the session was reloaded, navigated or replaced";

/** How to start the run again with its finished agents reused. */
const resumeLine = (run: WorkflowInterruptedRun): string => {
  const restart = workflowRestart(run.origin.source, run.origin.scriptPath);
  const script = restart === undefined ? "" : `, ${restart.argument}`;
  const rerun =
    run.workspaces.length === 0
      ? ""
      : " Writers that worked in worktrees run again, since this session can't manage those worktrees.";
  return `${run.finished} of its agents had finished. Start it again with the same args${script} and resumeFromRunId: "${run.runId}" to reuse their results.${rerun}`;
};

const interruptedOpening = (run: WorkflowInterruptedRun): ReadonlyArray<string> => {
  const subject = workflowRunSubject(run.name, run.runId);
  // Nothing suggests running again a run someone chose to stop.
  if (run.ended !== undefined) {
    const opening = `${subject} ${run.ended}, but its report didn't arrive ${undeliveredCause(run)}.`;
    return run.stopped ? [opening] : [opening, resumeLine(run)];
  }
  if (run.stopped)
    return [
      `${subject} was being stopped ${interruptedCause(run)}, so its final report will not arrive.`,
    ];
  return [
    `${subject} was interrupted ${interruptedCause(run)}, so its result will not arrive.`,
    resumeLine(run),
  ];
};

/**
 * The notice for a run an earlier activation of the session, or an earlier Pi process, left
 * unfinished. Its worktrees belong to that activation, so the notice offers manual recovery, not
 * review.
 */
export const interruptedWorkflowNotification = (
  run: WorkflowInterruptedRun,
): SubagentWorkflowNotification => {
  const text = [
    ...interruptedOpening(run),
    run.workspaces.length === 0
      ? undefined
      : [
          `Its writers created these worktrees ${run.restarted ? "before Pi restarted" : "before the reload, navigation or replacement"}, so subagent_workspace can't review, integrate or discard them in this session. Recover any changes you need by hand from each worktree's path, which subagent_workspace list shows:`,
          ...workflowWorkspaceLines(
            run.workspaces,
            (workspaceId) => `- ${workspaceId}`,
            WORKFLOW_WORKSPACE_LINES,
          ),
        ].join("\n"),
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
  return {
    type: "workflow",
    runId: run.runId,
    name: run.name,
    outcome: "interrupted",
    durationMs: 0,
    content: sanitizeNotificationContent(text),
    agents: { total: run.finished, failed: 0, stopped: 0, skipped: 0, reused: 0 },
    workspaces: run.workspaces,
  };
};
