import { formatDuration } from "pi-cosmic-core";
import {
  countWorkflowAgents,
  isWorkflowRunFinished,
  workflowWorkspaces,
  type WorkflowAgentView,
  type WorkflowRunView,
} from "../workflow/model.ts";
import type { WorkflowListing } from "../workflow/store.ts";
import type { WorkflowRunSummary } from "./workflow-schema.ts";

const STATUS_LOG_LINES = 20;
const NO_PHASE = "(no phase)";

export const workflowRunSummary = (run: WorkflowRunView): WorkflowRunSummary => {
  const counts = countWorkflowAgents(run.agents);
  return {
    id: run.id,
    name: run.name,
    state: run.state,
    phases: run.phases.length,
    ...(run.currentPhase !== undefined && { currentPhase: run.currentPhase }),
    agents: run.agents.length + run.reused,
    queued: counts.queued,
    running: counts.running,
    failed: counts.failed,
    skipped: counts.skipped,
    reused: run.reused,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    ...(run.failure && { failure: run.failure.message.slice(0, 512) }),
  };
};

const phaseList = (run: WorkflowRunView): string =>
  run.phases.length === 0
    ? "no declared phases"
    : `phases ${run.phases.map((phase) => phase.title).join(", ")}`;

export const workflowStartText = (run: WorkflowRunView): string =>
  [
    `Started workflow "${run.name}" (${run.id}) with ${phaseList(run)}.`,
    run.resumedFrom
      ? `Identical agent() calls reuse the results of ${run.resumedFrom}.`
      : undefined,
    `It runs in the background; you'll get one notification with its result. Continue with other work; use action "status" to check progress or "stop" to cancel.`,
  ]
    .filter(Boolean)
    .join(" ");

const countsText = (agents: ReadonlyArray<WorkflowAgentView>, reused = 0): string => {
  const counts = countWorkflowAgents(agents);
  return [
    counts.queued ? `${counts.queued} queued` : "",
    counts.running ? `${counts.running} running` : "",
    counts.completed ? `${counts.completed} done` : "",
    counts.failed ? `${counts.failed} failed` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
    reused ? `${reused} reused` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

const phaseLines = (run: WorkflowRunView): ReadonlyArray<string> => {
  const titles = [
    ...run.phases.map((phase) => phase.title),
    ...(run.agents.some((agent) => agent.phase === undefined) ? [NO_PHASE] : []),
  ];
  return titles.map((title) => {
    const members = run.agents.filter((agent) => (agent.phase ?? NO_PHASE) === title);
    const marker = title === run.currentPhase ? " (current)" : "";
    return `- ${title}${marker}: ${countsText(members) || "no agents"}`;
  });
};

const STOPPED_BY = { tool: " (stopped by you)", user: " (stopped by the user)" } as const;

const stateLine = (run: WorkflowRunView, now: number): string => {
  const elapsed = formatDuration(Math.max(0, (run.endedAt ?? now) - run.startedAt));
  const stoppedBy =
    run.stoppedBy !== undefined && (run.state === "stopped" || run.state === "stopping")
      ? STOPPED_BY[run.stoppedBy]
      : "";
  return isWorkflowRunFinished(run.state)
    ? `Workflow "${run.name}" (${run.id}): ${run.state}${stoppedBy} after ${elapsed}.`
    : `Workflow "${run.name}" (${run.id}): ${run.state}${stoppedBy} for ${elapsed}.`;
};

const outcomeLines = (run: WorkflowRunView): ReadonlyArray<string> => {
  if (run.state === "completed" && run.result)
    return [
      run.result.clipped
        ? `Result (clipped; ${run.result.path ? `the full value is in ${run.result.path}` : "the full value couldn't be saved"}):`
        : "Result:",
      run.result.text,
    ];
  if (run.failure)
    return [
      `Error: ${run.failure.name ? `${run.failure.name}: ` : ""}${run.failure.message}`,
      ...(run.failure.stack ? [run.failure.stack] : []),
      `Fix the script, then start it again with resumeFromRunId: "${run.id}".`,
    ];
  return [];
};

/** Progress for the main agent: phases, counts, recent log, workspaces and any outcome. */
export const workflowStatusText = (run: WorkflowRunView, now: number): string => {
  const workspaces = workflowWorkspaces(run);
  const logs = run.logs.slice(-STATUS_LOG_LINES);
  return [
    stateLine(run, now),
    run.currentPhase !== undefined ? `Current phase: ${run.currentPhase}` : undefined,
    `Agents: ${run.agents.length + run.reused} total${countsText(run.agents, run.reused) ? ` · ${countsText(run.agents, run.reused)}` : ""}`,
    ["Phases:", ...phaseLines(run)].join("\n"),
    workspaces.length > 0
      ? [
          "Worktree workspaces (review with subagent_workspace):",
          ...workspaces.map((agent) => `- ${agent.workspaceId} · ${agent.label} · ${agent.state}`),
        ].join("\n")
      : undefined,
    logs.length > 0
      ? [
          `Recent log (last ${logs.length}):`,
          ...logs.map(
            (entry) => `- ${entry.level === "warning" ? "[warning] " : ""}${entry.message}`,
          ),
        ].join("\n")
      : undefined,
    ...outcomeLines(run),
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
      ? [
          "No saved workflows. Save one as .pi/workflows/<name>.js (trusted projects) or <agent-dir>/workflows/<name>.js.",
        ]
      : [
          `Saved workflows (${listing.workflows.length}${listing.truncated ? ", more not listed" : ""}):`,
          ...listing.workflows.map((workflow) =>
            [
              `- ${workflow.name} [${workflow.scope}]: ${workflow.meta.description}`,
              workflow.meta.whenToUse ? `  When to use: ${workflow.meta.whenToUse}` : undefined,
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
