import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { clipText, formatDuration, safeTextPrefix } from "pi-cosmic-core";
import {
  sanitizeNotificationContent,
  type SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";
import type { WorkflowInterruptedRun } from "./journal.ts";
import {
  countWorkflowAgents,
  WORKFLOW_NOTIFICATION_MAX_CHARS,
  WORKFLOW_RESULT_MAX_CHARS,
  workflowWorkspaces,
  type WorkflowLogEntry,
  type WorkflowResult,
  type WorkflowRunView,
  type WorkflowWorkspace,
} from "./model.ts";

/** Log lines a notification repeats: every level for failed or stopped runs, warnings otherwise. */
const NOTIFICATION_LOG_LINES = 12;
/** Each repeated log line is shortened so the lines never crowd out the result. */
const NOTIFICATION_LOG_LINE_MAX_CHARS = 400;
/** Worktree proposals listed by id; the rest are counted. */
const NOTIFICATION_WORKSPACES = 40;
const STACK_MAX_CHARS = 8 * 1024;
const FAILURE_MESSAGE_MAX_CHARS = 4 * 1024;
/** Room kept for the saved file's path in a clipped result's header. */
const RESULT_PATH_RESERVE = 1024;
/** Fitting stops once the largest clip window that fits is known to within this many characters. */
const RESULT_FIT_PRECISION = 64;

/** The script's value as the main agent reads it: strings verbatim, anything else as JSON. */
export const workflowValueText = (value: Schema.Json): string =>
  Predicate.isString(value) ? value : JSON.stringify(value, null, 2);

const textSuffix = (text: string, length: number): string => {
  const suffix = text.slice(Math.max(0, text.length - length));
  // Never start the tail on the second half of a surrogate pair.
  return /^[\uDC00-\uDFFF]/u.test(suffix) ? suffix.slice(1) : suffix;
};

/** Keeps the head and tail of long text, which usually hold a value's summary and conclusion. */
export const clipWorkflowText = (text: string, maximum = WORKFLOW_RESULT_MAX_CHARS): string => {
  if (text.length <= maximum) return text;
  const marker = `\n… ${text.length - maximum} characters clipped …\n`;
  const budget = Math.max(0, maximum - marker.length);
  const head = Math.ceil(budget / 2);
  return `${safeTextPrefix(text, head)}${marker}${textSuffix(text, budget - head)}`;
};

const duration = (run: WorkflowRunView): string =>
  formatDuration(Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt));

const headline = (run: WorkflowRunView): string => {
  const subject = `Workflow "${run.name}" (${run.id})`;
  if (run.state === "completed") return `${subject} completed in ${duration(run)}.`;
  if (run.state === "failed") return `${subject} failed after ${duration(run)}.`;
  const stopped = run.stoppedBy === "user" ? "was stopped by the user" : "was stopped";
  return `${subject} ${stopped} after ${duration(run)}.`;
};

const agentsLine = (run: WorkflowRunView): string => {
  const counts = countWorkflowAgents(run.agents);
  return `Agents: ${[
    `${run.agents.length} started`,
    counts.failed > 0 ? `${counts.failed} failed` : "",
    counts.skipped > 0 ? `${counts.skipped} skipped or stopped` : "",
    run.reused > 0 ? `${run.reused} reused from ${run.resumedFrom ?? "the resumed run"}` : "",
  ]
    .filter(Boolean)
    .join(" · ")}.`;
};

const workspaceLines = <Workspace>(
  workspaces: ReadonlyArray<Workspace>,
  line: (workspace: Workspace) => string,
): ReadonlyArray<string> => {
  const hidden = workspaces.length - NOTIFICATION_WORKSPACES;
  return [
    ...workspaces.slice(0, NOTIFICATION_WORKSPACES).map(line),
    ...(hidden > 0 ? [`- ${hidden} more; list them with subagent_workspace.`] : []),
  ];
};

const workspacesSection = (run: WorkflowRunView): string | undefined => {
  const writers = workflowWorkspaces(run);
  if (writers.length === 0) return undefined;
  return [
    "Worktree proposals (review and integrate each with subagent_workspace):",
    ...workspaceLines(
      writers,
      (workspace: WorkflowWorkspace) =>
        `- ${workspace.workspaceId} · ${workspace.label} · ${workspace.state}`,
    ),
  ].join("\n");
};

const resultSection = (run: WorkflowRunView): string => {
  const result = run.result;
  if (!result) return "Result: null";
  if (!result.clipped) return `Result:\n${result.text}`;
  // The location comes first so clipping can never drop it.
  const saved =
    result.path !== undefined
      ? `the full value is in ${result.path}; read it with offset and limit`
      : "the full value couldn't be saved";
  return `Result (clipped; ${saved}):\n${result.text}`;
};

/** Redacted before it is bounded, so redaction can't lengthen a section past its bound. */
const boundedText = (text: string, maximum: number): string =>
  clipWorkflowText(sanitizeNotificationContent(text), maximum);

const logLine = (entry: WorkflowLogEntry): string =>
  `${entry.level === "warning" ? "warning: " : ""}${clipText(sanitizeNotificationContent(entry.message), NOTIFICATION_LOG_LINE_MAX_CHARS)}`;

const logSection = (title: string, entries: ReadonlyArray<WorkflowLogEntry>): string | undefined =>
  entries.length === 0
    ? undefined
    : [title, ...entries.slice(-NOTIFICATION_LOG_LINES).map(logLine)].join("\n");

/** The newest warnings, kept apart from the log, and how many earlier ones aren't shown. */
const warningsSection = (run: WorkflowRunView): string | undefined => {
  const warnings = (run.warnings ?? run.logs.filter((entry) => entry.level === "warning")).slice(
    -NOTIFICATION_LOG_LINES,
  );
  const hidden = (run.warningCount ?? warnings.length) - warnings.length;
  if (warnings.length === 0) return undefined;
  return [
    "Warnings:",
    ...(hidden > 0 ? [`(${hidden} earlier warnings aren't shown.)`] : []),
    ...warnings.map(logLine),
  ].join("\n");
};

const failureSection = (run: WorkflowRunView): string => {
  const failure = run.failure;
  const message = failure
    ? `${failure.name ? `${failure.name}: ` : ""}${failure.message}`
    : "The script failed.";
  return [
    `Error: ${boundedText(message, FAILURE_MESSAGE_MAX_CHARS)}`,
    failure?.stack && boundedText(failure.stack, STACK_MAX_CHARS),
    `Fix the script, then start it again with resumeFromRunId: "${run.id}" to reuse the results of agents that already finished.`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** Sections in order; a completed run's result comes last, sized to the room left for it. */
const sections = (run: WorkflowRunView): ReadonlyArray<string | undefined> => {
  const frame = [headline(run), agentsLine(run), workspacesSection(run)];
  if (run.state === "completed")
    return [
      ...frame,
      // Warnings explain null results, such as agent() calls that were invalid or failed.
      warningsSection(run),
      resultSection(run),
    ];
  if (run.state === "failed")
    return [...frame, failureSection(run), logSection("Recent log:", run.logs)];
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
  const counts = countWorkflowAgents(run.agents);
  return {
    type: "workflow",
    runId: run.id,
    name: run.name,
    outcome,
    durationMs: Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt),
    content: content(run),
    agents: {
      total: run.agents.length + run.reused,
      failed: counts.failed,
      skipped: counts.skipped,
      reused: run.reused,
    },
    workspaces: workflowWorkspaces(run).map((workspace) => workspace.workspaceId),
  };
};

const interruptedOpening = (run: WorkflowInterruptedRun): ReadonlyArray<string> => {
  const subject = `Workflow "${run.name}" (${run.runId})`;
  // Someone chose to stop it, so nothing suggests running it again.
  if (run.stopped)
    return [
      `${subject} was being stopped when the session was reloaded, navigated or replaced, so its final report will not arrive.`,
    ];
  const rerun =
    run.workspaces.length === 0
      ? ""
      : " Writers that worked in worktrees run again, since this session can't manage those worktrees.";
  return [
    `${subject} was interrupted when the session was reloaded, navigated or replaced, so its result will not arrive.`,
    `${run.finished} of its agents had finished. Start it again with resumeFromRunId: "${run.runId}" to reuse their results.${rerun}`,
  ];
};

/**
 * The notice for a run an earlier activation of the session left running at teardown. Its
 * worktrees belong to that activation, so the notice offers manual recovery, not review.
 */
export const interruptedWorkflowNotification = (
  run: WorkflowInterruptedRun,
): SubagentWorkflowNotification => {
  const text = [
    ...interruptedOpening(run),
    run.workspaces.length === 0
      ? undefined
      : [
          "Its writers created these worktrees before the reload, navigation or replacement, so subagent_workspace can't review, integrate or discard them in this session. Recover any changes you need by hand from each worktree's path, which subagent_workspace list shows:",
          ...workspaceLines(run.workspaces, (workspaceId) => `- ${workspaceId}`),
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
    agents: { total: run.finished, failed: 0, skipped: 0, reused: 0 },
    workspaces: run.workspaces,
  };
};
