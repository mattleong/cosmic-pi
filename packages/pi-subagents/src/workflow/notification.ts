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

const NOTIFICATION_LOG_LINES = 12;
const RESULT_PATH_RESERVE = 1024;
const RESULT_FIT_PRECISION = 64;

export const workflowValueText = (value: Schema.Json): string =>
  Predicate.isString(value) ? value : JSON.stringify(value, null, 2);

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
  return [...frame, logSection("Recent log:", run.logs)];
};

const content = (run: WorkflowRunView): string =>
  sanitizeNotificationContent(
    sections(run)
      .filter((section): section is string => section !== undefined)
      .join("\n\n"),
  );

const clippedLength = (run: WorkflowRunView, text: string): number =>
  content({ ...run, result: { text, clipped: true, path: "" } }).length + RESULT_PATH_RESERVE;

export const workflowResultBudget = (run: WorkflowRunView): number =>
  Math.max(
    0,
    Math.min(WORKFLOW_RESULT_MAX_CHARS, WORKFLOW_NOTIFICATION_MAX_CHARS - clippedLength(run, "")),
  );

export const fitWorkflowResult = (run: WorkflowRunView, text: string): WorkflowResult => {
  if (
    text.length <= WORKFLOW_RESULT_MAX_CHARS &&
    content({ ...run, result: { text, clipped: false } }).length <= WORKFLOW_NOTIFICATION_MAX_CHARS
  )
    return { text, clipped: false };
  const fits = (maximum: number) =>
    clippedLength(run, clipWorkflowText(text, maximum)) <= WORKFLOW_NOTIFICATION_MAX_CHARS;
  let low = 0;
  let high = workflowResultBudget(run);
  if (fits(high)) return { text: clipWorkflowText(text, high), clipped: true };
  while (high - low > RESULT_FIT_PRECISION) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return { text: clipWorkflowText(text, low), clipped: true };
};

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

const teardownCause = (run: WorkflowInterruptedRun, teardown: string): string =>
  run.restarted ? "before Pi restarted" : teardown;

const SESSION_TEARDOWN = "the session was reloaded, navigated or replaced";

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
  const interrupted = teardownCause(run, `when ${SESSION_TEARDOWN}`);
  if (run.ended !== undefined) {
    const undelivered = teardownCause(run, `before ${SESSION_TEARDOWN}`);
    const opening = `${subject} ${run.ended}, but its report didn't arrive ${undelivered}.`;
    return run.stopped ? [opening] : [opening, resumeLine(run)];
  }
  if (run.stopped)
    return [`${subject} was being stopped ${interrupted}, so its final report will not arrive.`];
  return [
    `${subject} was interrupted ${interrupted}, so its result will not arrive.`,
    resumeLine(run),
  ];
};

export const interruptedWorkflowNotification = (
  run: WorkflowInterruptedRun,
): SubagentWorkflowNotification => {
  const text = [
    ...interruptedOpening(run),
    run.workspaces.length === 0
      ? undefined
      : [
          `Its writers created these worktrees ${teardownCause(run, "before the reload, navigation or replacement")}, so subagent_workspace can't review, integrate or discard them in this session. Recover any changes you need by hand from each worktree's path, which subagent_workspace list shows:`,
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
