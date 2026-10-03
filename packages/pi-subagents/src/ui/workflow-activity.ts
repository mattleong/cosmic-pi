import type { ActivityItem, ActivityPhase } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent, sanitizeTerminalLine, sha256Text } from "pi-cosmic-core";
import type { SubagentWorkflowMembership } from "../run/model.ts";
import {
  isWorkflowAgentFinished,
  isWorkflowRunFinished,
  WORKFLOW_NARRATOR_MAX_CHARS,
  workflowPlannedByPhase,
  workflowReusedByPhase,
  workflowWorkspaces,
  type WorkflowAgentView,
  type WorkflowPlannedAgent,
  type WorkflowRunState,
  type WorkflowRunView,
} from "../workflow/model.ts";

const WORKFLOW_ITEM_PREFIX = "workflow:";
/** Activity shows at most this many phases per workflow. */
const ACTIVITY_PHASE_LIMIT = 32;
/** Queued rows per workflow; their phases' `work` counts include the rest. */
const QUEUED_ROWS_PER_WORKFLOW = 64;
/** Planned rows per workflow; the phase and workflow planned counts include the rest. */
const PLANNED_ROWS_PER_WORKFLOW = 64;
const DETAIL_LOG_LINES = 20;

const WORKFLOW_STATUS = {
  running: "running",
  stopping: "stopping",
  completed: "done",
  failed: "failed",
  stopped: "cancelled",
} satisfies Readonly<Record<WorkflowRunState, ActivityItem["status"]>>;

const workflowItemId = (runId: string): string => `${WORKFLOW_ITEM_PREFIX}${runId}`;

/** The workflow run id behind an Activity item id, if it names a workflow. */
export const workflowRunIdOf = (itemId: string): string | undefined =>
  itemId.startsWith(WORKFLOW_ITEM_PREFIX) ? itemId.slice(WORKFLOW_ITEM_PREFIX.length) : undefined;

const line = (text: string, maximumLength: number) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(text), { maximumLength });

/** An item before its revision is stamped; distributes over the status variants. */
type UnrevisionedItem<Item extends ActivityItem = ActivityItem> = Item extends ActivityItem
  ? Omit<Item, "revision">
  : never;

/**
 * Stamps a revision that changes only when this item's published fields or `identity` change, so
 * unrelated runs, workflows and log lines never void an action the user is confirming.
 */
export const withActivityRevision = (item: UnrevisionedItem, identity = ""): ActivityItem =>
  Object.freeze({
    ...item,
    revision: sha256Text(JSON.stringify([identity, item])).slice(0, 32),
  } satisfies ActivityItem);

type PhaseWork = NonNullable<ActivityPhase["work"]>;
const NO_WORK: PhaseWork = Object.freeze({ items: 0, finished: 0, stopped: 0 });

/**
 * Every agent and reused result per cleaned phase title, so a phase stays done after its rows
 * leave Activity, and a phase whose results were all reused on resume reads as done.
 */
const phaseWork = (run: WorkflowRunView): ReadonlyMap<string, PhaseWork> => {
  const work = new Map<string, PhaseWork>();
  const add = (phase: string, more: PhaseWork) => {
    const title = line(phase, 160);
    const counts = work.get(title) ?? NO_WORK;
    work.set(title, {
      items: counts.items + more.items,
      finished: counts.finished + more.finished,
      stopped: counts.stopped + more.stopped,
    });
  };
  for (const agent of run.agents) {
    if (agent.phase === undefined) continue;
    add(agent.phase, {
      items: 1,
      finished: Number(isWorkflowAgentFinished(agent.state)),
      stopped: Number(agent.state === "stopped" || agent.state === "skipped"),
    });
  }
  // A reused result finished in the run it came from; it has no agent view here.
  for (const [phase, count] of workflowReusedByPhase(run))
    add(phase, { items: count, finished: count, stopped: 0 });
  return work;
};

/** Unclaimed planned agents per cleaned phase title, including those without a row. */
const phasePlanned = (run: WorkflowRunView): ReadonlyMap<string, number> => {
  const planned = new Map<string, number>();
  for (const [phase, count] of workflowPlannedByPhase(run)) {
    const title = line(phase, 160);
    planned.set(title, (planned.get(title) ?? 0) + count);
  }
  return planned;
};

/**
 * Display phases: unique after cleaning, bounded for the protocol, with their work counts and
 * planned agents. Planned agents never count as work.
 */
const workflowActivityPhases = (run: WorkflowRunView): ReadonlyArray<ActivityPhase> => {
  const work = phaseWork(run);
  const planned = phasePlanned(run);
  const seen = new Set<string>();
  const phases: ActivityPhase[] = [];
  for (const phase of run.phases) {
    const title = line(phase.title, 160);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const plannedCount = planned.get(title) ?? 0;
    phases.push({
      title,
      ...(phase.detail !== undefined && { detail: line(phase.detail, 4096) }),
      work: work.get(title) ?? NO_WORK,
      ...(plannedCount > 0 && { planned: plannedCount }),
    });
    if (phases.length === ACTIVITY_PHASE_LIMIT) break;
  }
  return phases;
};

/** A member's phase when its workflow shows it; otherwise the member sits under the workflow. */
const shownPhase = (phase: string | undefined, phases: ReadonlyArray<ActivityPhase>) => {
  const title = phase === undefined ? undefined : line(phase, 160);
  return title !== undefined && phases.some((candidate) => candidate.title === title)
    ? { phase: title }
    : undefined;
};

/**
 * An owned run's place under its workflow, from the run's own membership. It holds when the
 * workflow has left the workflow snapshot, so the host's retained workflow row keeps its members.
 */
export const workflowMembership = (
  membership: SubagentWorkflowMembership,
  providerId: string,
): Pick<ActivityItem, "parent" | "phase"> => {
  const phase = membership.phase === undefined ? "" : line(membership.phase, 160);
  return {
    parent: Object.freeze({ providerId, itemId: workflowItemId(membership.workflowId) }),
    ...(phase && { phase }),
  };
};

/**
 * Planned agents no shown phase holds, such as those in phases past the ones Activity shows. Their
 * rows sit under the workflow, and the workflow counts them, so none is silently dropped.
 */
const unphasedPlanned = (
  run: WorkflowRunView,
  phases: ReadonlyArray<ActivityPhase>,
): Pick<ActivityItem, "unphasedPlanned"> => {
  const count = run.planned.filter((agent) => shownPhase(agent.phase, phases) === undefined).length;
  return count > 0 ? { unphasedPlanned: count } : {};
};

/** The narrator line Activity shows beneath the workflow: its newest log line, when there is one. */
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
  const title = line(run.name, 512);
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
              confirmation: `Stop workflow "${title}" and its agents?`,
              handoff: false,
            }),
          ]
        : [],
    ),
  });
};

const queuedItem = (
  agent: WorkflowAgentView,
  parent: Parent,
  phases: ReadonlyArray<ActivityPhase>,
): ActivityItem => {
  const label = line(agent.label, 512);
  return withActivityRevision({
    id: agent.runId,
    kind: "agent" as const,
    title: label,
    status: "pending" as const,
    parent,
    ...shownPhase(agent.phase, phases),
    ...(agent.profile !== undefined && { profile: line(agent.profile, 80) }),
    summary: "queued",
    // Skipping is final for the script, so it asks first like every other stop.
    actions: Object.freeze([
      Object.freeze({
        id: "skip",
        label: "Skip",
        confirmation: `Skip queued agent "${label}"? Its agent() call returns null.`,
        handoff: false,
      }),
    ]),
  });
};

/**
 * A declared agent no call has claimed, under the run id its call will take over. It is display
 * only: no actions, pending while the script can still call it and cancelled once it never will.
 * A never-run row ends with its workflow, so history retention drops older ones first.
 */
const plannedItem = (
  run: WorkflowRunView,
  agent: WorkflowPlannedAgent,
  parent: Parent,
  phases: ReadonlyArray<ActivityPhase>,
): ActivityItem =>
  withActivityRevision({
    id: agent.runId,
    kind: "agent" as const,
    title: line(agent.label, 512),
    status: isWorkflowRunFinished(run.state) ? ("cancelled" as const) : ("pending" as const),
    ...(isWorkflowRunFinished(run.state) && run.endedAt !== undefined && { endedAt: run.endedAt }),
    planned: true,
    parent,
    ...shownPhase(agent.phase, phases),
    ...(agent.profile !== undefined && { profile: line(agent.profile, 80) }),
  });

interface ShownWorkflow {
  readonly run: WorkflowRunView;
  readonly phases: ReadonlyArray<ActivityPhase>;
  readonly parent: Parent;
}

/**
 * Workflow items, then queued placeholders, then planned rows, each in the slots left. Queued and
 * planned rows use reserved run ids, so selection survives from planned through queued and
 * running; an id already shown is never repeated.
 */
export const workflowActivityItems = (input: {
  readonly runs: ReadonlyArray<WorkflowRunView>;
  readonly visibleRunIds: ReadonlySet<string>;
  readonly providerId: string;
  /** Item slots left for workflows and their placeholders. */
  readonly budget: number;
}): ReadonlyArray<ActivityItem> => {
  // Live workflows first, so history yields its slots before running work does. Every shown
  // workflow gets its row before any placeholder takes a slot.
  const shown: ReadonlyArray<ShownWorkflow> = [
    ...input.runs.filter((run) => !isWorkflowRunFinished(run.state)),
    ...input.runs.filter((run) => isWorkflowRunFinished(run.state)).reverse(),
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
  for (const { run, phases, parent } of shown) {
    if (isWorkflowRunFinished(run.state)) continue;
    const queued = run.agents.filter((agent) => agent.state === "queued");
    for (const agent of take(queued, QUEUED_ROWS_PER_WORKFLOW))
      items.push(queuedItem(agent, parent, phases));
  }
  for (const { run, phases, parent } of shown)
    for (const agent of take(run.planned, PLANNED_ROWS_PER_WORKFLOW))
      items.push(plannedItem(run, agent, parent, phases));
  return items;
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

const agentLine = (agent: WorkflowAgentView): string =>
  `- ${agent.label} · ${agent.state}${agent.reason ? ` · ${agent.reason}` : ""}`;

const plannedLine = (agent: WorkflowPlannedAgent): string => `- ${agent.label} · ${agent.phase}`;

/** Detail pane text for a workflow: what it is, its progress, log and outcome. */
export const workflowActivityDetail = (run: WorkflowRunView): string => {
  const workspaces = workflowWorkspaces(run);
  return sanitizeDiagnosticContent(
    [
      `${run.name}: ${run.state} · ${run.id}`,
      run.description,
      sourceText(run),
      `Args: ${JSON.stringify(run.args).slice(0, 2_000)}`,
      run.resumedFrom ? `Resumed from ${run.resumedFrom} · ${run.reused} reused` : "",
      `Output tokens: ${run.outputTokens}`,
      run.phases.length > 0
        ? `Phases:\n${run.phases.map((phase) => `- ${phase.title}${phase.title === run.currentPhase ? " (current)" : ""}`).join("\n")}`
        : "",
      run.agents.length > 0 ? `Agents:\n${run.agents.slice(-40).map(agentLine).join("\n")}` : "",
      run.planned.length > 0
        ? `${isWorkflowRunFinished(run.state) ? "Planned, never called" : "Planned, not called yet"}:\n${run.planned.slice(0, 40).map(plannedLine).join("\n")}`
        : "",
      workspaces.length > 0
        ? `Worktree proposals:\n${workspaces.map((agent) => `- ${agent.workspaceId} · ${agent.label}`).join("\n")}`
        : "",
      run.logs.length > 0
        ? `Log:\n${run.logs
            .slice(-DETAIL_LOG_LINES)
            .map((entry) => `${entry.level === "warning" ? "! " : ""}${entry.message}`)
            .join("\n")}`
        : "",
      run.failure
        ? `Error: ${run.failure.name ? `${run.failure.name}: ` : ""}${run.failure.message}${run.failure.stack ? `\n${run.failure.stack.slice(0, 3_000)}` : ""}`
        : "",
      run.result ? `Result:\n${run.result.text.slice(0, 6_000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    { maximumLength: 16_384 },
  );
};

/** Detail pane text for a declared agent that no agent() call has claimed. */
export const plannedAgentDetail = (run: WorkflowRunView, agent: WorkflowPlannedAgent): string =>
  sanitizeDiagnosticContent(
    [
      `${agent.label}: planned in workflow ${run.name}`,
      `Phase: ${agent.phase}`,
      agent.profile ? `Profile: ${agent.profile}` : "",
      isWorkflowRunFinished(run.state)
        ? "Not run: the workflow ended before its script called agent() for it."
        : "Not started yet. It becomes queued work when the script calls agent() for it.",
    ]
      .filter(Boolean)
      .join("\n"),
    { maximumLength: 4_096 },
  );

/** Detail pane text for an agent still waiting for a slot. */
export const queuedAgentDetail = (run: WorkflowRunView, agent: WorkflowAgentView): string =>
  sanitizeDiagnosticContent(
    [
      `${agent.label}: queued in workflow ${run.name}`,
      agent.phase ? `Phase: ${agent.phase}` : "",
      agent.profile ? `Profile: ${agent.profile}` : "",
      "Waiting for a free agent slot. Skipping it resolves its agent() call to null.",
    ]
      .filter(Boolean)
      .join("\n"),
    { maximumLength: 4_096 },
  );
