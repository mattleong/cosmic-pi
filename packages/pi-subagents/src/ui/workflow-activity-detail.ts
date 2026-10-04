import { ACTIVITY_LIMITS } from "pi-cosmic-ui/activity";
import { clipText, formatDuration, formatTokens, sanitizeDiagnosticContent } from "pi-cosmic-core";
import { WORKFLOW_ROOT_RESERVE } from "../run/limits.ts";
import type { SubagentUsage } from "../run/model.ts";
import {
  isWorkflowPlannedSkipped,
  isWorkflowRunFinished,
  type WorkflowAgentState,
  type WorkflowAgentView,
  type WorkflowAgentWaiting,
  type WorkflowPlannedAgent,
  type WorkflowRunView,
} from "../workflow/model.ts";
import {
  clipWorkflowText,
  WORKFLOW_LOG_LINE_MAX_CHARS,
  workflowBudgetLine,
  workflowFailureLine,
  workflowLogLine,
  workflowResultSection,
  workflowScriptLine,
  workflowUsageLine,
  workflowWaitingLine,
  workflowWorkspacesSection,
} from "../workflow/run-text.ts";
import { activityReasonLine } from "./workflow-activity.ts";

const DETAIL_LOG_LINES = 20;
const DETAIL_AGENT_LINES = 40;
const DETAIL_PLANNED_LINES = 40;
/** The result the workflow's detail shows, head and tail, leaving room for what follows it. */
const DETAIL_RESULT_MAX_CHARS = 6_000;
/** Placeholder details: a few lines about an agent that has no subagent session. */
const PLACEHOLDER_DETAIL_MAX_CHARS = 4_096;

/** What one agent's subagent has used so far, by its run id; undefined before it starts. */
export type WorkflowAgentUsage = (runId: string) => SubagentUsage | undefined;

const clipLog = (text: string): string => clipText(text, WORKFLOW_LOG_LINE_MAX_CHARS);

/** An agent's state as people read it, in the words the rest of Activity uses. */
const AGENT_STATES = {
  queued: "queued",
  running: "running",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  skipped: "skipped",
} satisfies Readonly<Record<WorkflowAgentState, string>>;

/** Where a member sits: its workflow, then its phase when it has one. */
export const workflowMemberLine = (name: string, phase: string | undefined): string =>
  `Workflow: ${name}${phase ? ` › ${phase}` : ""}`;

/**
 * Why a settled call ended without a result, in full, beside the state Activity shows; undefined
 * for a call that returned one, and for one whose row summary, the reason's first line clipped,
 * already says it all.
 */
export const workflowEndReasonLine = (agent: WorkflowAgentView): string | undefined =>
  agent.state === "completed" ||
  agent.reason === undefined ||
  activityReasonLine(agent.reason) === agent.reason
    ? undefined
    : `Reason: ${agent.reason}`;

/** Failed agents first, newest first; then running ones, longest first; then the rest. */
const AGENT_ORDER = {
  failed: 0,
  running: 1,
  completed: 2,
  stopped: 2,
  skipped: 2,
  queued: 3,
} satisfies Readonly<Record<WorkflowAgentState, number>>;

const agentOrder = (left: WorkflowAgentView, right: WorkflowAgentView): number =>
  AGENT_ORDER[left.state] - AGENT_ORDER[right.state] ||
  (left.state === "running"
    ? (left.startedAt ?? 0) - (right.startedAt ?? 0)
    : left.state === "queued"
      ? left.callId - right.callId
      : (right.endedAt ?? 0) - (left.endedAt ?? 0));

const agentLine = (agent: WorkflowAgentView, now: number, usage: WorkflowAgentUsage): string => {
  const tokens = usage(agent.runId)?.totalTokens ?? 0;
  const state = AGENT_STATES[agent.state];
  return [
    `- ${agent.label}`,
    agent.phase,
    // A reason such as "skipped by the user" already says the state.
    agent.reason?.startsWith(`${state} `) ? undefined : state,
    agent.startedAt === undefined
      ? undefined
      : formatDuration(Math.max(0, (agent.endedAt ?? now) - agent.startedAt)),
    tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined,
    agent.reason,
  ]
    .filter(Boolean)
    .join(" · ");
};

const agentsSection = (run: WorkflowRunView, now: number, usage: WorkflowAgentUsage): string => {
  if (run.agents.length === 0) return "";
  const shown = run.agents.toSorted(agentOrder).slice(0, DETAIL_AGENT_LINES);
  const hidden = run.agents.length - shown.length;
  return [
    "Agents:",
    ...shown.map((agent) => agentLine(agent, now, usage)),
    ...(hidden > 0 ? [`+${hidden} more`] : []),
  ].join("\n");
};

const plannedSection = (run: WorkflowRunView): string => {
  if (run.planned.length === 0) return "";
  const hidden = run.planned.length - DETAIL_PLANNED_LINES;
  return [
    isWorkflowRunFinished(run.state) ? "Planned, never called:" : "Planned, not called yet:",
    ...run.planned
      .slice(0, DETAIL_PLANNED_LINES)
      .map(
        (agent) =>
          `- ${agent.label} · ${agent.phase}${isWorkflowPlannedSkipped(agent) ? " · skipped" : ""}`,
      ),
    ...(hidden > 0 ? [`+${hidden} more`] : []),
  ].join("\n");
};

const sourceText = (run: WorkflowRunView): string => {
  switch (run.source.kind) {
    case "inline":
      return "Source: inline script";
    case "saved":
      return `Source: saved workflow ${run.source.name} (${run.source.scope}) · ${run.source.path}`;
    case "file":
      return `Source: ${run.source.path}`;
  }
};

/**
 * Detail pane text for a workflow as of `now`, beneath the state, phase and agent counts Activity
 * already shows, people first: its description and any error, its usage, budget and waits, its
 * files, what each agent did, failures first, then its log and result, and how it was started
 * last, so the clip drops the least useful text first. `usage` gives each started agent's tokens.
 */
export const workflowActivityDetail = (
  run: WorkflowRunView,
  now: number,
  usage: WorkflowAgentUsage,
): string =>
  sanitizeDiagnosticContent(
    [
      run.description,
      run.failure ? workflowFailureLine(run.failure) : "",
      [workflowUsageLine(run, now), workflowBudgetLine(run, formatTokens), workflowWaitingLine(run)]
        .filter(Boolean)
        .join("\n"),
      [workflowScriptLine(run), run.journalPath && `Results journal: ${run.journalPath}`]
        .filter(Boolean)
        .join("\n"),
      agentsSection(run, now, usage),
      plannedSection(run),
      workflowWorkspacesSection(run, "Worktree proposals:", undefined, (state) =>
        state === "reused" ? "reused" : AGENT_STATES[state],
      ) ?? "",
      run.logs.length > 0
        ? `Log:\n${run.logs
            .slice(-DETAIL_LOG_LINES)
            .map((entry) => workflowLogLine(entry, clipLog))
            .join("\n")}`
        : "",
      run.result
        ? workflowResultSection(run.result, {
            clip: (text) => clipWorkflowText(text, DETAIL_RESULT_MAX_CHARS),
            reader: "person",
          })
        : "",
      run.failure?.stack ? `Stack:\n${run.failure.stack.slice(0, 3_000)}` : "",
      [
        `Run: ${run.id}`,
        sourceText(run),
        `Args: ${JSON.stringify(run.args).slice(0, 2_000)}`,
        run.resumedFrom ? `Resumed from ${run.resumedFrom} · ${run.reused} reused` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
    { maximumLength: ACTIVITY_LIMITS.detail },
  );

const placeholderDetail = (lines: ReadonlyArray<string>): string =>
  sanitizeDiagnosticContent(lines.filter(Boolean).join("\n"), {
    maximumLength: PLACEHOLDER_DETAIL_MAX_CHARS,
  });

/**
 * What a declared agent no agent() call has claimed will do, by its run's state. A skipped one's
 * row summary already says it was skipped.
 */
const plannedText = (run: WorkflowRunView, agent: WorkflowPlannedAgent): string => {
  const ended = isWorkflowRunFinished(run.state);
  if (isWorkflowPlannedSkipped(agent))
    return ended
      ? "The workflow ended without reaching it."
      : "It won't start: when the workflow reaches it, the workflow continues without its result.";
  return ended
    ? "Not run: the workflow ended before it reached this agent."
    : "Not started yet; it queues once the workflow reaches it. If you skip it, the workflow continues without its result.";
};

/** Detail pane text for a declared agent that no agent() call has claimed. */
export const plannedAgentDetail = (run: WorkflowRunView, agent: WorkflowPlannedAgent): string =>
  placeholderDetail([plannedText(run, agent)]);

/** Why a queued agent waits, and what ends the wait. */
const waitingDetail = (waiting: WorkflowAgentWaiting | undefined): string => {
  switch (waiting?.kind) {
    case undefined:
      return "Queued; it starts once it gets a slot.";
    case "slot":
      return "Waiting for one of this workflow's agent slots; it starts when an earlier agent of the run finishes.";
    case "capacity":
      return `Waiting for a free subagent slot. Workflow agents leave ${WORKFLOW_ROOT_RESERVE} slots for the main agent and start in the order they were queued.`;
    case "writer":
      return waiting.paused
        ? `Waiting behind writer ${waiting.name}, which is paused and won't finish by itself.`
        : `Waiting behind writer ${waiting.name}, whose files it would also edit; it starts once that writer finishes.`;
  }
};

/** Detail pane text for an agent still waiting to start. */
export const queuedAgentDetail = (agent: WorkflowAgentView): string =>
  placeholderDetail([
    `${waitingDetail(agent.waiting)} If you skip it, the workflow continues without its result.`,
  ]);

/** Detail pane text for a call that settled before it got a subagent run. */
export const settledAgentDetail = (agent: WorkflowAgentView): string =>
  placeholderDetail([
    workflowEndReasonLine(agent) ?? "",
    "It never started, so it has no subagent session to inspect.",
  ]);
