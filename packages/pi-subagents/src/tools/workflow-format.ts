import { clipText, countLabel, formatDuration, formatElapsed } from "pi-cosmic-core";
import { workflowArgsSummary } from "../workflow/args.ts";
import type { WorkflowAgentAttention } from "../workflow/attention.ts";
import {
  countWorkflowRunAgents,
  isWorkflowRunFinished,
  workflowAgentTotal,
  workflowPlannedByPhase,
  workflowReusedByPhase,
  workflowSkippedByPhase,
  workflowSkippedPlanned,
  type WorkflowAgentView,
  type WorkflowRunView,
} from "../workflow/model.ts";
import {
  clipWorkflowText,
  WORKFLOW_LOG_LINE_MAX_CHARS,
  WORKFLOW_STATUS_WORKSPACES_TITLE,
  WORKFLOW_WORKSPACE_LINES,
  workflowAgentCountsText,
  workflowAgentsLine,
  workflowBudgetLine,
  workflowEditLine,
  workflowFailureSection,
  workflowJournalLine,
  workflowLogLine,
  workflowRestart,
  workflowResultSection,
  workflowRunSubject,
  workflowScriptLine,
  workflowStateLine,
  workflowStoppedByText,
  workflowUsageLine,
  workflowWaitingLine,
  workflowWaitingText,
  workflowWorkspacesSection,
} from "../workflow/run-text.ts";
import { WORKFLOW_BUDGET_ERROR } from "../workflow/prelude.ts";
import type { WorkflowRecordedRun } from "../workflow/run-record.ts";
import { savedWorkflowFiles, type WorkflowListing } from "../workflow/store.ts";
import type { WorkflowRunSummary } from "./workflow-schema.ts";

const STATUS_LOG_LINES = 20;
/** Agent rows status lists; the rest are counted by state on one more line. */
const STATUS_AGENT_ROWS = 24;
/** Rows each group of agents keeps when it has that many, before earlier groups take the rest. */
const STATUS_GROUP_MIN_ROWS = 4;
/** Lines the "Needs you" section lists; the rest are counted. */
const STATUS_ATTENTION_ROWS = 12;
/** A null result's reason, or a pending question, as an agent row shows it. */
const STATUS_REASON_MAX_CHARS = 200;
const NO_PHASE = "(no phase)";

export const workflowRunSummary = (run: WorkflowRunView): WorkflowRunSummary => {
  const counts = countWorkflowRunAgents(run);
  return {
    id: run.id,
    name: run.name,
    state: run.state,
    phases: run.phases.length,
    ...(run.currentPhase !== undefined && { currentPhase: run.currentPhase }),
    agents: workflowAgentTotal(run),
    queued: counts.queued,
    running: counts.running,
    failed: counts.failed,
    stopped: counts.stopped,
    skipped: counts.skipped,
    reused: run.reused,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    ...(run.failure && { failure: run.failure.message.slice(0, 512) }),
    ...(run.failure?.name === WORKFLOW_BUDGET_ERROR &&
      run.budget && { budgetFailure: { spent: run.budget.spent, total: run.budget.total } }),
  };
};

const phaseList = (run: WorkflowRunView): string => {
  if (run.phases.length === 0) return "no declared phases";
  const planned = workflowPlannedByPhase(run);
  return `phases ${run.phases
    .map((phase) => {
      const count = planned.get(phase.title);
      return count ? `${phase.title} (${count} planned)` : phase.title;
    })
    .join(", ")}`;
};

/**
 * What the main agent does once a run started: end its turn, since the run's notification starts
 * the next one. The start result ends with it.
 */
export const WORKFLOW_END_TURN_TEXT =
  "It runs in the background. End your turn now, after any unrelated work: the run's notification starts your next turn automatically with its result. Don't call status to wait for it or stop the run to answer sooner.";

/** When to stop a run, which the tool description and the result of a stop both give. */
export const WORKFLOW_STOP_GUIDANCE =
  "Stop a run only when the user asks or it is clearly broken (a wrong script, a runaway loop), never to answer sooner: its unfinished agents' work is lost, and a resume reruns them at full cost.";

export const workflowStartText = (run: WorkflowRunView): string =>
  [
    `Started workflow "${run.name}" (${run.id}) with ${phaseList(run)}.`,
    run.resumedFrom
      ? `Identical agent() calls reuse the results of ${run.resumedFrom}.`
      : undefined,
    run.budget
      ? `Once its agents spend ${run.budget.total} output tokens, agent() calls that haven't started throw a budget error.`
      : undefined,
    workflowEditLine(run),
    WORKFLOW_END_TURN_TEXT,
  ]
    .filter(Boolean)
    .join(" ");

/**
 * A repeated status call's answer while nothing material changed: the run's state and counts on
 * one line, then that polling won't bring the result sooner than the run's notification.
 */
export const workflowUnchangedStatusText = (run: WorkflowRunView, sinceMs: number): string => {
  const phase = run.currentPhase === undefined ? "" : `, phase ${run.currentPhase}`;
  const counts = workflowAgentCountsText(run.agents, run.reused, workflowSkippedPlanned(run));
  const agents = `${countLabel(workflowAgentTotal(run), "agent")}${counts ? ` · ${counts}` : ""}`;
  return [
    `${workflowRunSubject(run.name, run.id)}: ${run.state}${phase} · ${agents}.`,
    `Nothing changed since your last status call ${formatElapsed(sinceMs)} ago. Don't poll: end your turn; this run's notification starts your next turn when it finishes.`,
  ].join("\n");
};

const phaseLines = (run: WorkflowRunView): ReadonlyArray<string> => {
  const titles = [
    ...run.phases.map((phase) => phase.title),
    ...(run.agents.some((agent) => agent.phase === undefined) ? [NO_PHASE] : []),
  ];
  const planned = workflowPlannedByPhase(run);
  const skipped = workflowSkippedByPhase(run);
  // A phase whose calls were all reused has finished work but no agent views.
  const reused = workflowReusedByPhase(run);
  // Planned agents of a finished run were never called.
  const notStarted = isWorkflowRunFinished(run.state) ? "not run" : "planned";
  return titles.map((title) => {
    const members = run.agents.filter((agent) => (agent.phase ?? NO_PHASE) === title);
    const marker = title === run.currentPhase ? " (current)" : "";
    const count = planned.get(title);
    const parts = [
      workflowAgentCountsText(members, reused.get(title) ?? 0, skipped.get(title) ?? 0),
      count ? `${count} ${notStarted}` : "",
    ].filter(Boolean);
    return `- ${title}${marker}: ${parts.join(" · ") || "no agents"}`;
  });
};

const outcomeLines = (run: WorkflowRunView): ReadonlyArray<string> => {
  if (run.state === "completed" && run.result) return [workflowResultSection(run.result)];
  if (run.failure) return workflowFailureSection(run, clipWorkflowText);
  return [];
};

/**
 * Rows per group, in priority order: each group with agents keeps up to
 * {@link STATUS_GROUP_MIN_ROWS}, and earlier groups then take what is left of `limit`.
 */
const allotRows = (sizes: ReadonlyArray<number>, limit: number): ReadonlyArray<number> => {
  const floors = sizes.map((size) => Math.min(size, STATUS_GROUP_MIN_ROWS));
  let left = limit - floors.reduce((total, floor) => total + floor, 0);
  return sizes.map((size, index) => {
    const floor = floors[index] ?? 0;
    const extra = Math.max(0, Math.min(size - floor, left));
    left -= extra;
    return floor + extra;
  });
};

const reasonText = (reason: string | undefined): string =>
  reason ? ` · ${clipText(reason, STATUS_REASON_MAX_CHARS)}` : "";

const runningRow = (agent: WorkflowAgentView, now: number): string =>
  `- ${agent.label} · running ${formatDuration(Math.max(0, now - (agent.startedAt ?? agent.queuedAt)))} · ${agent.runId}`;

/** An agent that never started has no subagent, so its row names no run id. */
const endedRow = (agent: WorkflowAgentView): string =>
  `- ${agent.label} · ${agent.state}${agent.startedAt === undefined ? "" : ` · ${agent.runId}`}${reasonText(agent.reason)}`;

const queuedRow = (agent: WorkflowAgentView): string =>
  `- ${agent.label} · ${workflowWaitingText(agent.waiting)}`;

/**
 * At most {@link STATUS_AGENT_ROWS} agents, so a stuck agent can be named and targeted by its
 * subagent's run id: running agents first, longest running first, then agents that ended without
 * a result, with their reason, newest first, then queued agents with what they wait for, in call
 * order. Only agents that started have a subagent, so only their rows name a run id. One more line
 * counts the rest by state. Undefined when every agent completed, since the agents line counts them.
 */
const agentsSection = (run: WorkflowRunView, now: number): string | undefined => {
  const running = run.agents
    .filter((agent) => agent.state === "running")
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  const ended = run.agents
    .filter(
      (agent) => agent.state === "failed" || agent.state === "skipped" || agent.state === "stopped",
    )
    .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
  const queued = run.agents.filter((agent) => agent.state === "queued");
  const [runningRows = 0, endedRows = 0, queuedRows = 0] = allotRows(
    [running.length, ended.length, queued.length],
    STATUS_AGENT_ROWS,
  );
  const rows = [
    ...running.slice(0, runningRows).map((agent) => runningRow(agent, now)),
    ...ended.slice(0, endedRows).map(endedRow),
    ...queued.slice(0, queuedRows).map(queuedRow),
  ];
  if (rows.length === 0) return undefined;
  const rest = [
    ...run.agents.filter((agent) => agent.state === "completed"),
    ...running.slice(runningRows),
    ...ended.slice(endedRows),
    ...queued.slice(queuedRows),
  ];
  return [
    "Agents (a run id is the agent's subagent: subagent_status inspects it, and a subagent_lifecycle stop resolves a running agent's agent() call to null as stopped; queued agents have no subagent yet):",
    ...rows,
    ...(rest.length > 0 ? [`+${rest.length} more: ${workflowAgentCountsText(rest)}`] : []),
  ].join("\n");
};

/** Guidance for one agent that needs a person, matching what subagent_status recovers it with. */
const attentionLine = (agent: WorkflowAgentView | undefined, attention: WorkflowAgentAttention) => {
  const subject = `${agent?.label ?? "agent"} (${attention.runId})`;
  const inspect = `subagent_status({ runIds: ["${attention.runId}"] })`;
  const stop = "a subagent_lifecycle stop resolves its agent() call to null";
  switch (attention.kind) {
    case "question":
      return `- ${subject} asks: ${clipText(attention.message.replace(/\s+/gu, " "), STATUS_REASON_MAX_CHARS)} Answer with subagent_reply({ runId: "${attention.runId}", message: "..." }); the workflow continues after the reply.`;
    case "question-unavailable":
      return `- ${subject} waits for a reply, but its question isn't available; inspect it with ${inspect}.`;
    case "containment":
      return `- ${subject} wrote outside its write claims and is held for claim containment. Don't just resume it: ${inspect} shows the audit and the recovery (review or grant claims with subagent_claims, reopen admission with action "resume_admission", then resume or stop it).`;
    case "admission-paused":
      return `- ${subject} is held while writer admission is paused for another run's claim containment; ${inspect} names the offender and when to reopen admission with subagent_claims action "resume_admission".`;
    case "paused": {
      const kind = attention.writer ? "writer" : "agent";
      return attention.canResume
        ? `- ${subject} is a paused ${kind} and makes no progress until it is resumed with subagent_lifecycle action "resume"; ask the user before resuming one they paused. Otherwise ${stop}.`
        : `- ${subject} is a paused ${kind} whose backend can't resume it; ${stop}.`;
    }
  }
};

/** Queued agents behind each writer the user paused, which never finishes by itself. */
const pausedWriterLines = (run: WorkflowRunView): ReadonlyArray<string> => {
  const behind = new Map<string, { readonly writer: string; readonly labels: string[] }>();
  for (const agent of run.agents)
    if (agent.state === "queued" && agent.waiting?.kind === "writer" && agent.waiting.paused) {
      const { runId, name } = agent.waiting;
      const entry = behind.get(runId) ?? { writer: `${name} (${runId})`, labels: [] };
      entry.labels.push(agent.label);
      behind.set(runId, entry);
    }
  return [...behind.values()].map(
    ({ writer, labels }) =>
      `- ${countLabel(labels.length, "agent")} queued behind paused writer ${writer}: ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? `, +${labels.length - 3} more` : ""}`,
  );
};

/**
 * What waits on a person: questions, paused or contained agents, and agents queued behind a
 * paused writer, at most {@link STATUS_ATTENTION_ROWS} lines; undefined when nothing does.
 */
const needsYouSection = (
  run: WorkflowRunView,
  attention: ReadonlyArray<WorkflowAgentAttention>,
): string | undefined => {
  const agents = new Map(run.agents.map((agent) => [agent.runId, agent]));
  const lines = [
    ...attention.map((entry) => attentionLine(agents.get(entry.runId), entry)),
    ...pausedWriterLines(run),
  ];
  if (lines.length === 0) return undefined;
  const hidden = lines.length - STATUS_ATTENTION_ROWS;
  return [
    "Needs you:",
    ...lines.slice(0, STATUS_ATTENTION_ROWS),
    ...(hidden > 0 ? [`+${hidden} more; subagent_list shows the runs waiting for you.`] : []),
  ].join("\n");
};

/**
 * Progress for the main agent: counts, usage, what waits on a person, the agents worth a look,
 * phases, a bounded recent log, worktrees and any outcome. `attention` names the running agents
 * whose subagents need a person.
 */
export const workflowStatusText = (
  run: WorkflowRunView,
  now: number,
  attention: ReadonlyArray<WorkflowAgentAttention> = [],
): string => {
  const logs = run.logs.slice(-STATUS_LOG_LINES);
  return [
    workflowStateLine(run, now),
    run.currentPhase !== undefined ? `Current phase: ${run.currentPhase}` : undefined,
    workflowAgentsLine(run),
    workflowWaitingLine(run),
    workflowUsageLine(run, now),
    workflowBudgetLine(run),
    needsYouSection(run, attention),
    agentsSection(run, now),
    ["Phases:", ...phaseLines(run)].join("\n"),
    workflowScriptLine(run),
    run.journalPath === undefined ? undefined : workflowJournalLine(run.journalPath),
    workflowWorkspacesSection(run, WORKFLOW_STATUS_WORKSPACES_TITLE, WORKFLOW_WORKSPACE_LINES),
    logs.length > 0
      ? [
          `Recent log (last ${logs.length}):`,
          ...logs.map(
            (entry) =>
              `- ${workflowLogLine(entry, (message) => clipText(message, WORKFLOW_LOG_LINE_MAX_CHARS))}`,
          ),
        ].join("\n")
      : undefined,
    ...outcomeLines(run),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

/** A stop's result: the run's final state, and when to stop one, after a stop the main agent made. */
export const workflowStopText = (run: WorkflowRunView, now: number): string =>
  run.stoppedBy === "tool"
    ? `${workflowStatusText(run, now)}\n${WORKFLOW_STOP_GUIDANCE}`
    : workflowStatusText(run, now);

/** A run only its files describe, in the summary shape status details carry. */
export const workflowRecordedRunSummary = (run: WorkflowRecordedRun): WorkflowRunSummary => ({
  id: run.id,
  name: run.name,
  state: run.state,
  phases: 0,
  agents: run.finished,
  queued: 0,
  running: 0,
  failed: 0,
  skipped: 0,
  reused: 0,
  startedAt: run.startedAt,
  ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
});

const recordedStateLine = (run: WorkflowRecordedRun, now: number): string => {
  const subject = workflowRunSubject(run.name, run.id);
  if (run.runningIn !== undefined)
    return `${subject}: running in another Pi process (pid ${run.runningIn}) for ${formatDuration(Math.max(0, now - run.startedAt))}.`;
  if (run.endedAt === undefined) return `${subject}: interrupted before it could record its end.`;
  const stoppedBy = run.state === "stopped" ? workflowStoppedByText(run.stoppedBy) : "";
  const span = formatDuration(Math.max(0, run.endedAt - run.startedAt));
  const since = formatDuration(Math.max(0, now - run.endedAt));
  return `${subject}: ${run.state}${stoppedBy} after ${span}, ${since} ago.`;
};

/** How to start the run again, unless it still runs elsewhere or the user stopped it. */
const recordedResumeLine = (run: WorkflowRecordedRun): string | undefined => {
  if (run.runningIn !== undefined || run.stoppedBy === "user") return undefined;
  const restart = workflowRestart(run.source, run.scriptPath);
  const start =
    restart === undefined
      ? "start an edited script with the same args"
      : `start it with the same args, ${restart.argument}`;
  return `To run it again, ${start} and resumeFromRunId: "${run.id}"; agent() calls that finished with the same prompt and options are reused.`;
};

/**
 * Status for a run only its files describe, such as one an earlier Pi process ran: its state,
 * when it ended, how many agents finished, and where its script and results journal are.
 */
export const workflowRecordedStatusText = (run: WorkflowRecordedRun, now: number): string => {
  const restart = workflowRestart(run.source, run.scriptPath);
  return [
    recordedStateLine(run, now),
    run.runningIn === undefined
      ? "Only its run record is left: it ran in an earlier Pi process or before a reload, so its phases, log and result aren't shown."
      : "It runs in another Pi process, so only its run record is shown here, without its phases, log or result.",
    `Agents finished with a result: ${run.finished}.`,
    restart === undefined ? undefined : `Script: ${restart.file}`,
    run.journalPath === undefined ? undefined : workflowJournalLine(run.journalPath),
    recordedResumeLine(run),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

/** Saved workflows the agent can start by name, followed by this session's runs. */
export const workflowListText = (
  listing: WorkflowListing,
  runs: ReadonlyArray<WorkflowRunView>,
): string => {
  const saved =
    listing.workflows.length === 0
      ? [`No saved workflows. Save one as ${savedWorkflowFiles(listing.locations)}.`]
      : [
          `Saved workflows (${listing.workflows.length}${listing.truncated ? ", more not listed" : ""}):`,
          ...listing.workflows.map((workflow) =>
            [
              `- ${workflow.name} [${workflow.scope}]: ${workflow.meta.description}`,
              `  Path: ${workflow.path}`,
              workflow.meta.whenToUse ? `  When to use: ${workflow.meta.whenToUse}` : undefined,
              workflow.meta.args === undefined
                ? undefined
                : `  Args: ${workflowArgsSummary(workflow.meta.args)}`,
              workflow.meta.phases?.length
                ? `  Phases: ${workflow.meta.phases.map((phase) => phase.title).join(", ")}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        ];
  const diagnostics =
    listing.diagnostics.length === 0
      ? []
      : [
          "Unreadable or invalid workflow files:",
          ...listing.diagnostics.map((entry) => `- ${entry.path}: ${entry.message}`),
        ];
  const sessionRuns =
    runs.length === 0
      ? ["No workflow runs in this session."]
      : ["This session's runs:", ...runs.map((run) => `- ${run.id} · ${run.name} · ${run.state}`)];
  return [saved.join("\n"), diagnostics.join("\n"), sessionRuns.join("\n")]
    .filter(Boolean)
    .join("\n\n");
};
