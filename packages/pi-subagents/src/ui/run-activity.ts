import { ACTIVITY_LIMITS, type ActivityItem } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent, synchronousNow } from "pi-cosmic-core";
import {
  isActiveRunState,
  isParentActionRequiredRun,
  isTerminalRunState,
  type SubagentProjection,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import {
  isWorkflowRunFinished,
  type WorkflowAgentView,
  type WorkflowRunView,
} from "../workflow/model.ts";
import {
  EMPTY_ACTIVITY_PRESENTATION,
  type SubagentActivityPresentationSnapshot,
} from "./activity-panel.ts";
import { withActivityRevision } from "./activity-revision.ts";
import { runActivityDetail } from "./run-activity-detail.ts";
import { formatRunRoute } from "./run-presentation.ts";
import {
  canInterruptRun,
  canRenameRun,
  canResumeRun,
  runMessageMode,
  type RunMessageMode,
} from "./run-state.ts";
import { projectFleetTree } from "./run-tree-rows.ts";
import {
  activityReasonLine,
  isWorkflowAgentUnstarted,
  settledWorkflowCalls,
  workflowActivityItems,
  workflowMembership,
  workflowRunIdOf,
} from "./workflow-activity.ts";
import {
  plannedAgentDetail,
  queuedAgentDetail,
  settledAgentDetail,
  workflowActivityDetail,
} from "./workflow-activity-detail.ts";

// Pure projection of runs and workflows into Activity items, details and action policy; the host
// adapter registers the provider and dispatches actions.

export const SUBAGENT_ACTIVITY_PROVIDER = "pi-subagents";

/** The workflow views Activity was last published, the only ones the host holds revisions for. */
export interface WorkflowActivitySnapshot {
  readonly runs: ReadonlyArray<WorkflowRunView>;
}

export const EMPTY_WORKFLOWS: WorkflowActivitySnapshot = Object.freeze({ runs: [] });

/**
 * Workflows that still own their members. A workflow releases its members before its view
 * finishes, so a finished or evicted workflow owns none.
 */
export const liveWorkflowIds = (snapshot: WorkflowActivitySnapshot): ReadonlySet<string> =>
  new Set(snapshot.runs.filter((run) => !isWorkflowRunFinished(run.state)).map((run) => run.id));

/** Whether a running workflow, not the root, still receives this run's results. */
export const isOwnedByLiveWorkflow = (run: SubagentRunView, live: ReadonlySet<string>): boolean =>
  run.workflow !== undefined && live.has(run.workflow.workflowId);

const RUN_STATUS = {
  starting: "pending",
  running: "running",
  waiting_for_parent: "blocked",
  paused: "blocked",
  reported: "done",
  completed: "done",
  failed: "failed",
  stopping: "stopping",
  stopped: "cancelled",
} satisfies Readonly<Record<SubagentRunState, ActivityItem["status"]>>;

/** A run's Activity status, and what it waits for when a person or the parent must act. */
function activityAttention(run: SubagentRunView) {
  if (run.writeAdmissionPaused) {
    // An older question does not make active claim containment ready for parent recovery.
    const blockedReason = run.writeViolationOffender
      ? isParentActionRequiredRun({ ...run, question: undefined })
        ? "file-access-review"
        : "write-containment"
      : "file-access";
    return { status: "blocked", blockedReason } as const;
  }
  if (run.state === "waiting_for_parent" && run.question !== undefined)
    return { status: "needs-input", inputTarget: "parent" } as const;
  if (run.state === "paused" || run.state === "waiting_for_parent")
    return { status: "blocked", blockedReason: "parent-review" } as const;
  return { status: RUN_STATUS[run.state] } as const;
}

/**
 * A member whose agent() call failed, such as a run whose structured result wasn't valid JSON,
 * shows as failed, as its phase counts it, unless its run still needs attention.
 */
function memberAttention(run: SubagentRunView, call: WorkflowAgentView | undefined) {
  const attention = activityAttention(run);
  return call?.state === "failed" &&
    (attention.status === "done" || attention.status === "cancelled")
    ? ({ status: "failed" } as const)
    : attention;
}

/** An action that hands off to its own input. */
const handoff = (id: string, label: string) => ({ id, label, handoff: true as const });

const MESSAGE_ACTIONS = {
  reply: handoff("reply", "Reply"),
  guidance: handoff("message", "Message"),
} satisfies Readonly<Record<RunMessageMode, ReturnType<typeof handoff>>>;

/**
 * The actions a run offers; `owned`: a running workflow still owns it. Unlike the fleet, Activity
 * offers stop to a stopping run, which joins its cleanup; paused file access withholds resume and
 * messages; and a reply needs its question. A paused owned run continues its owned assignment, but
 * a completed one stays with its workflow until the workflow ends, because the root refuses a
 * resume whose result only the root would receive.
 */
export function runActions(run: SubagentRunView, title: string, owned: boolean) {
  const mode = run.writeAdmissionPaused ? undefined : runMessageMode(run);
  return [
    ...(isActiveRunState(run.state)
      ? [
          {
            id: "stop",
            label: "Stop",
            confirmation: `Stop "${title}" and all its subagents?${owned ? " The workflow continues without its result." : ""}`,
            handoff: false as const,
          },
        ]
      : []),
    ...(canInterruptRun(run)
      ? [
          {
            id: "interrupt",
            label: "Interrupt",
            confirmation: `Interrupt "${title}"? Its subagents keep running.`,
            handoff: false as const,
          },
        ]
      : []),
    ...(canResumeRun(run) && !run.writeAdmissionPaused && !(owned && run.state === "completed")
      ? [handoff("resume", "Resume")]
      : []),
    ...(mode && (mode !== "reply" || run.question) ? [MESSAGE_ACTIONS[mode]] : []),
    ...(canRenameRun(run) ? [handoff("rename", "Rename")] : []),
  ];
}

/** What an action applies to beyond the published fields: the assignment and its question. */
const runIdentity = (run: SubagentRunView): string =>
  JSON.stringify([run.reportGeneration, run.sessionId ?? null, run.question?.requestId ?? null]);

/**
 * A run's summary, beside the state Activity draws itself: why a member's agent() call ended
 * without a result, or why the run failed, so a failure reads at a glance; otherwise what it is
 * doing, when it says.
 */
const runSummary = (
  run: SubagentRunView,
  call: WorkflowAgentView | undefined,
): Pick<ActivityItem, "summary"> => {
  const reason =
    call?.reason !== undefined && call.state !== "completed"
      ? call.reason
      : run.state === "failed"
        ? run.error
        : undefined;
  const summary = reason ? activityReasonLine(reason) : (run.currentTool ?? run.progress);
  return summary
    ? { summary: sanitizeDiagnosticContent(summary, { maximumLength: ACTIVITY_LIMITS.text }) }
    : {};
};

/**
 * A member nests under its workflow while the workflow runs, and its finished runs stay there as
 * history, even after the workflow leaves the snapshot. A run working again after its workflow
 * ended belongs to the root, so it is published as a root run.
 */
const workflowPlacement = (run: SubagentRunView, owned: boolean) =>
  run.workflow !== undefined &&
  (run.parentRunId ?? "root") === "root" &&
  (owned || isTerminalRunState(run.state))
    ? workflowMembership(run.workflow, SUBAGENT_ACTIVITY_PROVIDER)
    : undefined;

export function subagentActivityItems(
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = EMPTY_ACTIVITY_PRESENTATION,
  workflowSnapshot: WorkflowActivitySnapshot = EMPTY_WORKFLOWS,
): readonly ActivityItem[] {
  const awaited = new Set(presentation.awaits.flatMap((lease) => lease.runIds));
  const rows = projectFleetTree(projection.runs, "root").rows;
  // Placeholders fill the slots runs leave.
  const workflows = workflowActivityItems({
    runs: workflowSnapshot.runs,
    visibleRunIds: new Set(rows.map(({ run }) => run.id)),
    providerId: SUBAGENT_ACTIVITY_PROVIDER,
    budget: Math.max(0, ACTIVITY_LIMITS.items - rows.length),
  });
  const live = liveWorkflowIds(workflowSnapshot);
  const callOf = settledWorkflowCalls(workflowSnapshot.runs);
  const runs = rows.map(({ run }) => {
    const title = sanitizeDiagnosticContent(run.name, { maximumLength: ACTIVITY_LIMITS.title });
    const owned = isOwnedByLiveWorkflow(run, live);
    const call = callOf(run);
    return withActivityRevision(
      {
        id: run.id,
        kind: "agent" as const,
        title,
        ...memberAttention(run, call),
        awaited: awaited.has(run.id),
        startedAt: run.startedAt,
        updatedAt: run.lastActivityAt,
        ...runSummary(run, call),
        actions: Object.freeze(
          runActions(run, title, owned).map((action) => Object.freeze(action)),
        ),
        route: sanitizeDiagnosticContent(formatRunRoute(run), {
          maximumLength: ACTIVITY_LIMITS.route,
        }),
        ...(run.profile !== undefined && { profile: run.profile }),
        ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
        ...(run.parentRunId &&
          run.parentRunId !== "root" && {
            parent: Object.freeze({
              providerId: SUBAGENT_ACTIVITY_PROVIDER,
              itemId: run.parentRunId,
            }),
          }),
        ...workflowPlacement(run, owned),
      },
      runIdentity(run),
    );
  });
  return Object.freeze([...workflows, ...runs].slice(0, ACTIVITY_LIMITS.items));
}

/** Detail for a workflow, or for an agent of one that has no subagent run to show. */
const workflowDetail = (
  workflows: WorkflowActivitySnapshot,
  id: string,
  projection: SubagentProjection,
  now: number,
): string | undefined => {
  const runId = workflowRunIdOf(id);
  if (runId !== undefined) {
    const run = workflows.runs.find((candidate) => candidate.id === runId);
    if (!run) return undefined;
    const usage = new Map(projection.runs.map((view) => [view.id, view.usage]));
    return workflowActivityDetail(run, now, (agentRunId) => usage.get(agentRunId));
  }
  for (const run of workflows.runs) {
    const agent = run.agents.find((candidate) => candidate.runId === id);
    if (agent?.state === "queued") return queuedAgentDetail(agent);
    if (agent && isWorkflowAgentUnstarted(agent)) return settledAgentDetail(agent);
    const planned = run.planned.find((candidate) => candidate.runId === id);
    if (planned) return plannedAgentDetail(run, planned);
  }
  return undefined;
};

export function subagentActivityDetail(
  projection: SubagentProjection,
  id: string,
  workflows: WorkflowActivitySnapshot = EMPTY_WORKFLOWS,
  now: number = synchronousNow(),
): string | undefined {
  const run = projectFleetTree(projection.runs, "root").rows.find((row) => row.run.id === id)?.run;
  if (!run) return workflowDetail(workflows, id, projection, now);
  const owned = isOwnedByLiveWorkflow(run, liveWorkflowIds(workflows));
  return runActivityDetail(run, {
    call: settledWorkflowCalls(workflows.runs)(run),
    nested: workflowPlacement(run, owned) !== undefined,
  });
}
