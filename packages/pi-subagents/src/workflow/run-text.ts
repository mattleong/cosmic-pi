import {
  countLabel,
  formatCost,
  formatDuration,
  formatTokens,
  safeTextPrefix,
  safeTextSuffix,
} from "pi-cosmic-core";
import {
  countWorkflowAgents,
  countWorkflowRunAgents,
  isWorkflowRunFinished,
  WORKFLOW_RESULT_MAX_CHARS,
  workflowAgentTotal,
  workflowSkippedPlanned,
  workflowUnchangedWorkspaces,
  workflowWorkspaces,
  type WorkflowAgentView,
  type WorkflowAgentWaiting,
  type WorkflowFailure,
  type WorkflowLogEntry,
  type WorkflowResult,
  type WorkflowRunView,
  type WorkflowSource,
  type WorkflowStopOrigin,
  type WorkflowWorkspace,
} from "./model.ts";
import { WORKFLOW_BUDGET_ERROR } from "./prelude.ts";

// Text sections every description of a run shares: the completion notification, the tool's
// status text and the Activity detail. Each view orders and bounds them itself.

/** Marks a warning among a run's log lines, in every view. */
export const WORKFLOW_WARNING_MARKER = "warning: ";

/** Worktree proposals the notification and status list by id; the rest are counted. */
export const WORKFLOW_WORKSPACE_LINES = 40;
/** Each log line the notification and status repeat is shortened to this. */
export const WORKFLOW_LOG_LINE_MAX_CHARS = 400;
/** A failed script's error message, as the notification and status show it. */
export const WORKFLOW_FAILURE_MESSAGE_MAX_CHARS = 4 * 1024;
/** A failed script's stack, as the notification and status show it. */
export const WORKFLOW_STACK_MAX_CHARS = 8 * 1024;

/** Heads a finished run's worktree proposals in its completion notification. */
export const WORKFLOW_WORKSPACES_TITLE =
  "Worktree proposals (review and integrate each with subagent_workspace):";

/** Heads the worktrees in the status text, which may list writers that are still running. */
export const WORKFLOW_STATUS_WORKSPACES_TITLE =
  "Worktree workspaces (review with subagent_workspace):";

const verbatim = (text: string): string => text;

/** How every view names a run. */
export const workflowRunSubject = (name: string, id: string): string =>
  `Workflow "${name}" (${id})`;

/** Time from the run's start to its end, or to `now` while it runs. */
const elapsed = (run: WorkflowRunView, now: number): string =>
  formatDuration(Math.max(0, (run.endedAt ?? now) - run.startedAt));

/** A finished run's opening sentence: its outcome, who stopped it and how long it ran. */
export const workflowOutcomeHeadline = (run: WorkflowRunView): string => {
  const subject = workflowRunSubject(run.name, run.id);
  const duration = elapsed(run, run.startedAt);
  if (run.state === "completed") return `${subject} completed in ${duration}.`;
  if (run.state === "failed") return `${subject} failed after ${duration}.`;
  const stopped = run.stoppedBy === "user" ? "was stopped by the user" : "was stopped";
  return `${subject} ${stopped} after ${duration}.`;
};

const STOPPED_BY = { tool: " (stopped by you)", user: " (stopped by the user)" } as const;

/** Who stopped a run, as a state line names them after the state; empty when nobody did. */
export const workflowStoppedByText = (origin: WorkflowStopOrigin | undefined): string =>
  origin === undefined ? "" : STOPPED_BY[origin];

/** A run's state as of `now`, who stopped it, and how long it ran or has been running. */
export const workflowStateLine = (run: WorkflowRunView, now: number): string => {
  const stoppedBy =
    run.state === "stopped" || run.state === "stopping" ? workflowStoppedByText(run.stoppedBy) : "";
  const span = isWorkflowRunFinished(run.state) ? "after" : "for";
  return `${workflowRunSubject(run.name, run.id)}: ${run.state}${stoppedBy} ${span} ${elapsed(run, now)}.`;
};

/**
 * What the run's live agents used as of `now`: all tokens with the output share, the cost when
 * known (a lower bound when some agents reported none), tool calls and how long the run took.
 * Results reused on resume cost nothing and are only counted.
 */
export const workflowUsageLine = (run: WorkflowRunView, now: number): string | undefined => {
  const usage = run.usage;
  // A run whose agents never ran has nothing to report.
  if (usage.totalTokens === 0 && usage.toolUses === 0 && run.reused === 0) return undefined;
  return [
    `Usage: ${formatTokens(usage.totalTokens)} tokens (${formatTokens(usage.output)} output)`,
    usage.cost === undefined ? "" : `${usage.unpriced > 0 ? "≥" : "~"}${formatCost(usage.cost)}`,
    countLabel(usage.toolUses, "tool use"),
    elapsed(run, now),
    run.reused > 0 ? `${countLabel(run.reused, "reused result")} at no cost` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

/**
 * The run's token budget, what its agents spent of it, and the calls it refused; undefined without
 * one. `tokens` writes each count, exact by default.
 */
export const workflowBudgetLine = (
  run: WorkflowRunView,
  tokens: (count: number) => string = String,
): string | undefined => {
  const budget = run.budget;
  if (!budget) return undefined;
  const refused =
    budget.refused === 0
      ? ""
      : ` · ${budget.refused} agent() ${budget.refused === 1 ? "call" : "calls"} refused`;
  return `Budget: ${tokens(budget.spent)} of ${tokens(budget.total)} output tokens spent${refused}`;
};

/** What a queued agent waits for, as status and Activity name it. */
export const workflowWaitingText = (waiting: WorkflowAgentWaiting | undefined): string => {
  switch (waiting?.kind) {
    case undefined:
      return "queued";
    case "slot":
      return "waiting for a run slot";
    case "writer":
      return `waiting for ${waiting.paused ? "paused " : ""}writer ${waiting.name}`;
  }
};

/** Queued agents by what they wait for; undefined when none is queued. */
export const workflowWaitingLine = (run: WorkflowRunView): string | undefined => {
  const counts = new Map<string, number>();
  for (const agent of run.agents)
    if (agent.state === "queued") {
      const text = workflowWaitingText(agent.waiting);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  if (counts.size === 0) return undefined;
  return `Queued: ${[...counts].map(([text, count]) => `${count} ${text}`).join(" · ")}`;
};

/**
 * Agents by state, empty states left out; `reused` counts results a resume reused, and
 * `skippedPlanned` planned agents the user skipped before any call claimed them.
 */
export const workflowAgentCountsText = (
  agents: ReadonlyArray<WorkflowAgentView>,
  reused = 0,
  skippedPlanned = 0,
): string => {
  const agentCounts = countWorkflowAgents(agents);
  const counts = { ...agentCounts, skipped: agentCounts.skipped + skippedPlanned };
  return [
    counts.queued ? `${counts.queued} queued` : "",
    counts.running ? `${counts.running} running` : "",
    counts.completed ? `${counts.completed} finished` : "",
    counts.failed ? `${counts.failed} failed` : "",
    counts.stopped ? `${counts.stopped} stopped` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
    reused ? `${reused} reused` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

/** A live or finished run's agents line: the total, then the counts by state. */
export const workflowAgentsLine = (run: WorkflowRunView): string => {
  const counts = workflowAgentCountsText(run.agents, run.reused, workflowSkippedPlanned(run));
  return `Agents: ${workflowAgentTotal(run)} total${counts ? ` · ${counts}` : ""}`;
};

/**
 * A finished run's agents: how many started, then how many failed, were stopped or skipped,
 * whether or not they started, planned agents skipped before any call claimed them included, then
 * the calls that never started, results reused and planned agents never called.
 */
export const workflowFinishedAgentsLine = (run: WorkflowRunView): string => {
  const counts = countWorkflowRunAgents(run);
  const neverCalled = run.planned.length - workflowSkippedPlanned(run);
  const started = run.agents.filter((agent) => agent.startedAt !== undefined).length;
  const unstarted = run.agents.length - started;
  return `Agents: ${[
    `${started} started`,
    counts.failed > 0 ? `${counts.failed} failed` : "",
    counts.stopped > 0 ? `${counts.stopped} stopped` : "",
    counts.skipped > 0 ? `${counts.skipped} skipped` : "",
    unstarted > 0 ? `${countLabel(unstarted, "agent() call")} never started` : "",
    run.reused > 0 ? `${run.reused} reused from ${run.resumedFrom ?? "the resumed run"}` : "",
    neverCalled > 0 ? `${neverCalled} planned in meta but never called` : "",
  ]
    .filter(Boolean)
    .join(" · ")}.`;
};

/** Keeps the head and tail of long text, which usually hold a value's summary and conclusion. */
export const clipWorkflowText = (text: string, maximum = WORKFLOW_RESULT_MAX_CHARS): string => {
  if (text.length <= maximum) return text;
  const marker = `\n… ${text.length - maximum} characters clipped …\n`;
  const budget = Math.max(0, maximum - marker.length);
  const head = Math.ceil(budget / 2);
  return `${safeTextPrefix(text, head)}${marker}${safeTextSuffix(text, budget - head)}`;
};

/**
 * A completed run's result: a header naming the file a clipped value was saved to, which comes
 * first so no later clipping can drop it, then the text, which `clip` bounds. The main agent is
 * also told how to read that file; people only where it is.
 */
export const workflowResultSection = (
  result: WorkflowResult,
  options: {
    readonly clip?: (text: string) => string;
    readonly reader?: "agent" | "person";
  } = {},
): string => {
  const text = (options.clip ?? verbatim)(result.text);
  if (!result.clipped) return `Result:\n${text}`;
  const hint = options.reader === "person" ? "" : "; read it with offset and limit";
  const saved =
    result.path !== undefined
      ? `the full value is in ${result.path}${hint}`
      : "the full value couldn't be saved";
  return `Result (clipped; ${saved}):\n${text}`;
};

/** The script's error on one line, led by its name (`Error` when it has none); `clip` bounds the text. */
export const workflowFailureLine = (
  failure: WorkflowFailure | undefined,
  clip: (text: string) => string = verbatim,
): string =>
  `${failure?.name || "Error"}: ${clip(failure ? failure.message : "The script failed.")}`;

/**
 * A failed run's error, its stack and how to fix and restart the script, as separate sections;
 * `bound` clips the error and the stack to the sizes it is given.
 */
export const workflowFailureSection = (
  run: WorkflowRunView,
  bound: (text: string, maximum: number) => string,
): ReadonlyArray<string> => [
  workflowFailureLine(run.failure, (message) => bound(message, WORKFLOW_FAILURE_MESSAGE_MAX_CHARS)),
  ...(run.failure?.stack ? [bound(run.failure.stack, WORKFLOW_STACK_MAX_CHARS)] : []),
  workflowRetryLine(run),
];

/** A log line, its warning marked; `clip` bounds the message. */
export const workflowLogLine = (
  entry: WorkflowLogEntry,
  clip: (text: string) => string = verbatim,
): string => `${entry.level === "warning" ? WORKFLOW_WARNING_MARKER : ""}${clip(entry.message)}`;

/**
 * The newest `limit` warnings, kept apart from the log, and how many earlier ones aren't shown;
 * undefined when the run logged none. `line` renders each warning.
 */
export const workflowWarningsSection = (
  run: WorkflowRunView,
  limit: number,
  line: (entry: WorkflowLogEntry) => string,
): string | undefined => {
  const warnings = (run.warnings ?? run.logs.filter((entry) => entry.level === "warning")).slice(
    -limit,
  );
  const hidden = (run.warningCount ?? warnings.length) - warnings.length;
  if (warnings.length === 0) return undefined;
  return [
    "Warnings:",
    ...(hidden > 0 ? [`(${hidden} earlier warnings aren't shown.)`] : []),
    ...warnings.map(line),
  ].join("\n");
};

/** At most `limit` worktree lines, then how many more subagent_workspace lists. */
export const workflowWorkspaceLines = <Workspace>(
  workspaces: ReadonlyArray<Workspace>,
  line: (workspace: Workspace) => string,
  limit = Number.POSITIVE_INFINITY,
): ReadonlyArray<string> => {
  const hidden = workspaces.length - limit;
  return [
    ...workspaces.slice(0, limit).map(line),
    ...(hidden > 0 ? [`+${hidden} more; list them with subagent_workspace.`] : []),
  ];
};

/** How a view names a worktree writer's state: the run's own words by default. */
type WorkspaceStateText = (state: WorkflowWorkspace["state"]) => string;

/** How many worktree writers left no changes, whose worktrees were discarded; undefined for none. */
const unchangedWorkspacesLine = (run: WorkflowRunView): string | undefined => {
  const count = workflowUnchangedWorkspaces(run);
  if (count === 0) return undefined;
  const writers = countLabel(count, "worktree writer");
  return count === 1
    ? `${writers} made no changes, so its worktree was discarded.`
    : `${writers} made no changes, so their worktrees were discarded.`;
};

/**
 * The run's worktree proposals under `title`, at most `limit` listed, then how many writers made
 * no changes, which are only counted; undefined when there are neither. `stateText` names each
 * writer's state, exactly by default.
 */
export const workflowWorkspacesSection = (
  run: WorkflowRunView,
  title: string,
  limit?: number,
  stateText: WorkspaceStateText = String,
): string | undefined => {
  const workspaces = workflowWorkspaces(run);
  const unchanged = unchangedWorkspacesLine(run);
  const line = (workspace: WorkflowWorkspace) =>
    `- ${workspace.workspaceId} · ${workspace.label} · ${stateText(workspace.state)}`;
  const lines = [
    ...(workspaces.length === 0 ? [] : [title, ...workflowWorkspaceLines(workspaces, line, limit)]),
    ...(unchanged === undefined ? [] : [unchanged]),
  ];
  return lines.length === 0 ? undefined : lines.join("\n");
};

/** Where the main agent reads every finished agent's actual return value. */
export const workflowJournalLine = (path: string): string =>
  `Results journal: ${path} has one JSON line per finished agent() call (label, phase, state, reason, usage, result); Read it to check what each agent actually returned.`;

/** The file a fix edits and the start argument that runs it again. */
export interface WorkflowRestart {
  readonly file: string;
  readonly argument: string;
}

/**
 * Where a run's script is fixed and started again: a saved workflow's or script file's own path,
 * so the fix outlives the run, and only an inline script's private copy. Undefined for an inline
 * script whose copy couldn't be saved.
 */
export const workflowRestart = (
  source: WorkflowSource,
  scriptPath: string | undefined,
): WorkflowRestart | undefined => {
  switch (source.kind) {
    case "saved":
      return { file: source.path, argument: `name: ${JSON.stringify(source.name)}` };
    case "file":
      return { file: source.path, argument: `scriptPath: ${JSON.stringify(source.path)}` };
    case "inline":
      return scriptPath === undefined
        ? undefined
        : { file: scriptPath, argument: `scriptPath: ${JSON.stringify(scriptPath)}` };
  }
};

/** The script a fix edits, when there is one. */
export const workflowScriptLine = (run: WorkflowRunView): string | undefined => {
  const restart = workflowRestart(run.source, run.scriptPath);
  return restart === undefined ? undefined : `Script: ${restart.file}`;
};

/** The edit-and-restart loop over the run's script: its own file, or an inline script's copy. */
export const workflowEditLine = (run: WorkflowRunView): string | undefined => {
  const restart = workflowRestart(run.source, run.scriptPath);
  if (restart === undefined) return undefined;
  const edit =
    run.source.kind === "inline"
      ? `Its script is saved at ${restart.file}: to change the workflow, edit that file`
      : `To change the workflow, edit ${restart.file}`;
  return `${edit} with your file tools and start it again with ${restart.argument}, adding resumeFromRunId: "${run.id}" to reuse agents that finished.`;
};

/** How the main agent extends or adjusts a completed run, reusing its unchanged agent() calls. */
export const workflowExtendLine = (run: WorkflowRunView): string => {
  const restart = workflowRestart(run.source, run.scriptPath);
  const resume = `resumeFromRunId: "${run.id}"; unchanged agent() calls are reused.`;
  return restart === undefined
    ? `To extend or adjust this run, start an edited script with ${resume}`
    : `To extend or adjust this run, edit ${restart.file} and start it with ${restart.argument} plus ${resume}`;
};

/** An uncaught budget error from the script itself; a foreign name never decides recovery. */
export const isWorkflowBudgetFailure = (failure: WorkflowFailure | undefined): boolean =>
  failure?.name === WORKFLOW_BUDGET_ERROR &&
  (failure.kind === undefined || failure.kind === "script");

/**
 * Failure-specific recovery: runtime failures need a user-managed restart, not script edits.
 * The sandbox also stops when a script exhausts its memory, so that guidance offers both.
 * When an uncaught budget error failed the run, it says first that a resumed run gets a new
 * budget, since the limit the user set is already spent.
 */
export const workflowRetryLine = (run: WorkflowRunView): string => {
  const restart = workflowRestart(run.source, run.scriptPath);
  const resume = `resumeFromRunId: "${run.id}" to reuse the results of agents that already finished`;
  const target = restart === undefined ? "" : `${restart.argument} and `;
  const runtime = `Preserve or resolve outstanding worktree proposals and stop other active work before asking the user to fully restart Pi and continue this session. Check the runtime installation if the failure persists. Then retry the unchanged workflow with ${target}resumeFromRunId: "${run.id}" and the same args; eligible completed agent results may be reused.`;
  if (run.failure?.kind === "runner") return `The workflow runtime failed. ${runtime}`;
  if (run.failure?.kind === "sandbox") {
    const fix =
      restart === undefined
        ? `change the script, then start it again with ${resume}`
        : `edit ${restart.file} with your file tools, then start it again with ${restart.argument} and ${resume}`;
    return `The workflow sandbox stopped. If the error mentions memory, the script held too much data at once, such as large agent() results: reduce it, then ${fix}. Otherwise treat it as a runtime failure. ${runtime}`;
  }
  if (isWorkflowBudgetFailure(run.failure)) {
    const spent =
      "The run's token budget is spent, and a run resumed with resumeFromRunId gets a new one, so ask the user before spending more.";
    return restart === undefined
      ? `${spent} To continue, guard agent() calls with budget.remaining() and start the script again with ${resume}.`
      : `${spent} To continue, edit ${restart.file} with your file tools to guard agent() calls with budget.remaining(), then start it again with ${restart.argument} and ${resume}.`;
  }
  return restart === undefined
    ? `Fix the script, then start it again with ${resume}.`
    : `Fix the script: edit ${restart.file} with your file tools, then start it again with ${restart.argument} and ${resume}.`;
};
