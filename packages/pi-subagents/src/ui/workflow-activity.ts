import { ACTIVITY_LIMITS, type ActivityItem, type ActivityPhase } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import {
  isTerminalRunState,
  type SubagentRunView,
  type SubagentWorkflowMembership,
} from "../run/model.ts";
import {
  isWorkflowAgentFinished,
  isWorkflowPlannedSkipped,
  isWorkflowRunFinished,
  WORKFLOW_NARRATOR_MAX_CHARS,
  WORKFLOW_SKIPPED_BEFORE_START,
  workflowPlannedByPhase,
  workflowReusedByPhase,
  type WorkflowAgentView,
  type WorkflowPlannedAgent,
  type WorkflowRunState,
  type WorkflowRunView,
} from "../workflow/model.ts";
import { workflowWaitingText } from "../workflow/run-text.ts";
import { withActivityRevision } from "./activity-revision.ts";

const WORKFLOW_ITEM_PREFIX = "workflow:";
const QUEUED_ROWS_PER_WORKFLOW = 64;
const PLANNED_ROWS_PER_WORKFLOW = 64;
const SETTLED_ROWS_PER_WORKFLOW = 16;
const ROW_SUMMARY_MAX_CHARS = 200;

const WORKFLOW_STATUS = {
  running: "running",
  stopping: "stopping",
  completed: "done",
  failed: "failed",
  stopped: "cancelled",
} satisfies Readonly<Record<WorkflowRunState, ActivityItem["status"]>>;

const workflowItemId = (runId: string): string => `${WORKFLOW_ITEM_PREFIX}${runId}`;

export const workflowRunIdOf = (itemId: string): string | undefined =>
  itemId.startsWith(WORKFLOW_ITEM_PREFIX) ? itemId.slice(WORKFLOW_ITEM_PREFIX.length) : undefined;

const line = (text: string, maximumLength: number) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(text), { maximumLength });

const phaseTitle = (title: string) => line(title, ACTIVITY_LIMITS.phaseTitle);

export const activityReasonLine = (reason: string): string =>
  line(reason.split("\n", 1)[0] ?? "", ROW_SUMMARY_MAX_CHARS);

export const isWorkflowAgentUnstarted = (agent: WorkflowAgentView): boolean =>
  isWorkflowAgentFinished(agent.state) && agent.startedAt === undefined;

export const settledWorkflowCalls = (runs: ReadonlyArray<WorkflowRunView>) => {
  const indexes = new Map<string, ReadonlyMap<string, WorkflowAgentView>>();
  const callOf = (run: SubagentRunView, workflowId: string) => {
    let index = indexes.get(workflowId);
    if (index === undefined) {
      const workflow = runs.find((candidate) => candidate.id === workflowId);
      index = new Map(workflow?.agents.map((agent) => [agent.runId, agent]));
      indexes.set(workflowId, index);
    }
    return index.get(run.id);
  };
  return (run: SubagentRunView): WorkflowAgentView | undefined => {
    if (run.workflow === undefined || !isTerminalRunState(run.state)) return undefined;
    const call = callOf(run, run.workflow.workflowId);
    return call?.endedAt !== undefined && (run.endedAt ?? 0) <= call.endedAt ? call : undefined;
  };
};

type PhaseWork = NonNullable<ActivityPhase["work"]>;
const NO_WORK: PhaseWork = Object.freeze({
  items: 0,
  finished: 0,
  stopped: 0,
  failed: 0,
  skipped: 0,
});

const phaseWork = (run: WorkflowRunView): ReadonlyMap<string, PhaseWork> => {
  const work = new Map<string, PhaseWork>();
  const add = (phase: string, more: PhaseWork) => {
    const title = phaseTitle(phase);
    const counts = work.get(title) ?? NO_WORK;
    work.set(title, {
      items: counts.items + more.items,
      finished: counts.finished + more.finished,
      stopped: counts.stopped + more.stopped,
      failed: (counts.failed ?? 0) + (more.failed ?? 0),
      skipped: (counts.skipped ?? 0) + (more.skipped ?? 0),
    });
  };
  for (const agent of run.agents) {
    if (agent.phase === undefined) continue;
    add(agent.phase, {
      items: 1,
      finished: Number(isWorkflowAgentFinished(agent.state)),
      stopped: Number(agent.state === "stopped"),
      failed: Number(agent.state === "failed"),
      skipped: Number(agent.state === "skipped"),
    });
  }
  for (const [phase, count] of workflowReusedByPhase(run))
    add(phase, { items: count, finished: count, stopped: 0, failed: 0, skipped: 0 });
  return work;
};

const phasePlanned = (run: WorkflowRunView): ReadonlyMap<string, number> => {
  const planned = new Map<string, number>();
  for (const [phase, count] of workflowPlannedByPhase(run)) {
    const title = phaseTitle(phase);
    planned.set(title, (planned.get(title) ?? 0) + count);
  }
  return planned;
};

const workflowActivityPhases = (run: WorkflowRunView): ReadonlyArray<ActivityPhase> => {
  const work = phaseWork(run);
  const planned = phasePlanned(run);
  const seen = new Set<string>();
  const phases: ActivityPhase[] = [];
  for (const phase of run.phases) {
    const title = phaseTitle(phase.title);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const plannedCount = planned.get(title) ?? 0;
    phases.push({
      title,
      ...(phase.detail !== undefined && { detail: line(phase.detail, ACTIVITY_LIMITS.text) }),
      work: work.get(title) ?? NO_WORK,
      ...(plannedCount > 0 && { planned: plannedCount }),
    });
    if (phases.length === ACTIVITY_LIMITS.phases) break;
  }
  return phases;
};

const shownPhase = (phase: string | undefined, phases: ReadonlyArray<ActivityPhase>) => {
  const title = phase === undefined ? undefined : phaseTitle(phase);
  return title !== undefined && phases.some((candidate) => candidate.title === title)
    ? { phase: title }
    : undefined;
};

export const workflowMembership = (
  membership: SubagentWorkflowMembership,
  providerId: string,
): Pick<ActivityItem, "parent" | "phase"> => {
  const phase = membership.phase === undefined ? "" : phaseTitle(membership.phase);
  return {
    parent: Object.freeze({ providerId, itemId: workflowItemId(membership.workflowId) }),
    ...(phase && { phase }),
  };
};

const unphasedPlanned = (
  run: WorkflowRunView,
  phases: ReadonlyArray<ActivityPhase>,
): Pick<ActivityItem, "unphasedPlanned"> => {
  const count = run.planned.filter(
    (agent) => !isWorkflowPlannedSkipped(agent) && shownPhase(agent.phase, phases) === undefined,
  ).length;
  return count > 0 ? { unphasedPlanned: count } : {};
};

const narrator = (run: WorkflowRunView): Pick<ActivityItem, "summary"> => {
  const text = run.lastLog === undefined ? "" : line(run.lastLog, WORKFLOW_NARRATOR_MAX_CHARS);
  return text ? { summary: text } : {};
};

const lastUpdate = (run: WorkflowRunView): number =>
  Math.max(
    run.endedAt ?? run.startedAt,
    run.logs.at(-1)?.at ?? 0,
    ...run.agents.map((agent) => agent.endedAt ?? agent.startedAt ?? agent.queuedAt),
  );

type Parent = NonNullable<ActivityItem["parent"]>;

const workflowItem = (run: WorkflowRunView, phases: ReadonlyArray<ActivityPhase>): ActivityItem => {
  const title = line(run.name, ACTIVITY_LIMITS.title);
  const live = !isWorkflowRunFinished(run.state);
  return withActivityRevision({
    id: workflowItemId(run.id),
    kind: "workflow" as const,
    title,
    status: WORKFLOW_STATUS[run.state],
    startedAt: run.startedAt,
    updatedAt: lastUpdate(run),
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    ...narrator(run),
    phases: Object.freeze(phases),
    ...shownPhase(run.currentPhase, phases),
    ...unphasedPlanned(run, phases),
    actions: Object.freeze(
      live
        ? [
            Object.freeze({
              id: "stop",
              label: "Stop workflow",
              confirmation: `Stop workflow "${title}"? Its running agents stop and the rest won't start.`,
              handoff: false,
            }),
          ]
        : [],
    ),
  });
};

const agentRow = (
  agent: Pick<WorkflowAgentView, "runId" | "label" | "phase" | "profile">,
  parent: Parent,
  phases: ReadonlyArray<ActivityPhase>,
) => ({
  id: agent.runId,
  kind: "agent" as const,
  title: line(agent.label, ACTIVITY_LIMITS.title),
  parent,
  ...shownPhase(agent.phase, phases),
  ...(agent.profile !== undefined && { profile: line(agent.profile, ACTIVITY_LIMITS.profile) }),
});

const skipActions = (confirmation: string): ActivityItem["actions"] =>
  Object.freeze([Object.freeze({ id: "skip", label: "Skip", confirmation, handoff: false })]);

const queuedItem = (
  agent: WorkflowAgentView,
  parent: Parent,
  phases: ReadonlyArray<ActivityPhase>,
): ActivityItem => {
  const row = agentRow(agent, parent, phases);
  return withActivityRevision({
    ...row,
    status: "pending" as const,
    summary: line(workflowWaitingText(agent.waiting), ROW_SUMMARY_MAX_CHARS),
    actions: skipActions(
      `Skip queued agent "${row.title}"? The workflow continues without its result.`,
    ),
  });
};

const settledItem = (
  agent: Pick<
    WorkflowAgentView,
    "runId" | "label" | "state" | "phase" | "profile" | "endedAt" | "reason"
  >,
  parent: Parent,
  phases: ReadonlyArray<ActivityPhase>,
): ActivityItem =>
  withActivityRevision({
    ...agentRow(agent, parent, phases),
    status: agent.state === "failed" ? ("failed" as const) : ("cancelled" as const),
    ...(agent.state === "skipped" && { skipped: true }),
    ...(agent.endedAt !== undefined && { endedAt: agent.endedAt, updatedAt: agent.endedAt }),
    ...(agent.reason !== undefined && { summary: activityReasonLine(agent.reason) }),
    actions: Object.freeze([]),
  });

const plannedItem = (
  run: WorkflowRunView,
  agent: WorkflowPlannedAgent,
  parent: Parent,
  phases: ReadonlyArray<ActivityPhase>,
): ActivityItem => {
  if (agent.skippedAt !== undefined)
    return settledItem(
      {
        ...agent,
        state: "skipped",
        endedAt: agent.skippedAt,
        reason: WORKFLOW_SKIPPED_BEFORE_START,
      },
      parent,
      phases,
    );
  const row = agentRow(agent, parent, phases);
  const ended = isWorkflowRunFinished(run.state);
  return withActivityRevision({
    ...row,
    status: ended ? ("cancelled" as const) : ("pending" as const),
    ...(ended && run.endedAt !== undefined && { endedAt: run.endedAt }),
    planned: true,
    actions: ended
      ? Object.freeze([])
      : skipActions(
          `Skip planned agent "${row.title}" before it starts? The workflow continues without its result.`,
        ),
  });
};

const unstartedAgents = (run: WorkflowRunView): ReadonlyArray<WorkflowAgentView> =>
  run.agents
    .filter(isWorkflowAgentUnstarted)
    .toSorted(
      (left, right) =>
        Number(right.state === "failed") - Number(left.state === "failed") ||
        (right.endedAt ?? 0) - (left.endedAt ?? 0),
    );

interface ShownWorkflow {
  readonly run: WorkflowRunView;
  readonly phases: ReadonlyArray<ActivityPhase>;
  readonly parent: Parent;
}

export const workflowActivityItems = (input: {
  readonly runs: ReadonlyArray<WorkflowRunView>;
  readonly visibleRunIds: ReadonlySet<string>;
  readonly providerId: string;
  readonly budget: number;
}): ReadonlyArray<ActivityItem> => {
  const shown: ReadonlyArray<ShownWorkflow> = [
    ...input.runs.filter((run) => !isWorkflowRunFinished(run.state)),
    ...input.runs.filter((run) => isWorkflowRunFinished(run.state)).toReversed(),
  ]
    .slice(0, Math.max(0, input.budget))
    .map((run) => ({
      run,
      phases: workflowActivityPhases(run),
      parent: Object.freeze({ providerId: input.providerId, itemId: workflowItemId(run.id) }),
    }));
  const items = shown.map(({ run, phases }) => workflowItem(run, phases));
  const used = new Set(input.visibleRunIds);
  const take = <Entry extends { readonly runId: string }>(
    entries: ReadonlyArray<Entry>,
    limit: number,
  ): ReadonlyArray<Entry> => {
    const taken = entries
      .filter((entry) => !used.has(entry.runId))
      .slice(0, Math.max(0, Math.min(limit, input.budget - items.length)));
    for (const entry of taken) used.add(entry.runId);
    return taken;
  };
  const settled = ({ run, phases, parent }: ShownWorkflow) => {
    for (const agent of take(unstartedAgents(run), SETTLED_ROWS_PER_WORKFLOW))
      items.push(settledItem(agent, parent, phases));
  };
  const queued = ({ run, phases, parent }: ShownWorkflow) => {
    const waiting = run.agents.filter((agent) => agent.state === "queued");
    for (const agent of take(waiting, QUEUED_ROWS_PER_WORKFLOW))
      items.push(queuedItem(agent, parent, phases));
  };
  const planned = ({ run, phases, parent }: ShownWorkflow) => {
    for (const agent of take(run.planned, PLANNED_ROWS_PER_WORKFLOW))
      items.push(plannedItem(run, agent, parent, phases));
  };
  const live = shown.filter(({ run }) => !isWorkflowRunFinished(run.state));
  const finished = shown.filter(({ run }) => isWorkflowRunFinished(run.state));
  live.forEach(settled);
  live.forEach(queued);
  live.forEach(planned);
  finished.forEach(settled);
  finished.forEach(planned);
  return items;
};
