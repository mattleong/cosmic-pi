import type { ActivityItem, ActivityPhase } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent, sanitizeTerminalLine, sha256Text } from "pi-cosmic-core";
import type { SubagentWorkflowMembership } from "../run/model.ts";
import {
  countWorkflowAgents,
  isWorkflowAgentFinished,
  isWorkflowRunFinished,
  workflowReusedByPhase,
  workflowWorkspaces,
  type WorkflowAgentView,
  type WorkflowRunState,
  type WorkflowRunView,
} from "../workflow/model.ts";

const WORKFLOW_ITEM_PREFIX = "workflow:";
/** Activity shows at most this many phases per workflow. */
const ACTIVITY_PHASE_LIMIT = 32;
/** Queued rows per workflow; the rest are counted in the workflow summary. */
const QUEUED_ROWS_PER_WORKFLOW = 64;
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

/** Display phases: unique after cleaning, bounded for the protocol, with their work counts. */
const workflowActivityPhases = (run: WorkflowRunView): ReadonlyArray<ActivityPhase> => {
  const work = phaseWork(run);
  const seen = new Set<string>();
  const phases: ActivityPhase[] = [];
  for (const phase of run.phases) {
    const title = line(phase.title, 160);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    phases.push({
      title,
      ...(phase.detail !== undefined && { detail: line(phase.detail, 4096) }),
      work: work.get(title) ?? NO_WORK,
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

const workflowSummary = (run: WorkflowRunView, phases: ReadonlyArray<ActivityPhase>): string => {
  const counts = countWorkflowAgents(run.agents);
  const current =
    run.currentPhase === undefined
      ? -1
      : run.phases.findIndex((phase) => phase.title === run.currentPhase);
  return [
    isWorkflowRunFinished(run.state)
      ? run.state
      : current >= 0 && phases.length > 0
        ? `phase ${current + 1}/${run.phases.length}`
        : "running",
    counts.running ? `${counts.running} running` : "",
    counts.queued ? `${counts.queued} queued` : "",
    counts.completed ? `${counts.completed} done` : "",
    counts.failed ? `${counts.failed} failed` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
    run.reused ? `${run.reused} reused` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

const lastUpdate = (run: WorkflowRunView): number =>
  Math.max(
    run.endedAt ?? run.startedAt,
    run.logs.at(-1)?.at ?? 0,
    ...run.agents.map((agent) => agent.endedAt ?? agent.startedAt ?? agent.queuedAt),
  );

/**
 * Workflow items and queued placeholders. Placeholders use the reserved run id, so selection
 * survives from queued through running; an id the projection already shows is never repeated.
 */
export const workflowActivityItems = (input: {
  readonly runs: ReadonlyArray<WorkflowRunView>;
  readonly visibleRunIds: ReadonlySet<string>;
  readonly providerId: string;
  /** Item slots left for workflows and their placeholders. */
  readonly budget: number;
}): ReadonlyArray<ActivityItem> => {
  const items: ActivityItem[] = [];
  // Live workflows first, so history yields its slots before running work does. Every shown
  // workflow gets its row before any placeholder takes a slot.
  const ordered = [
    ...input.runs.filter((run) => !isWorkflowRunFinished(run.state)),
    ...input.runs.filter((run) => isWorkflowRunFinished(run.state)).reverse(),
  ].slice(0, Math.max(0, input.budget));
  let budget = Math.max(0, input.budget) - ordered.length;
  for (const run of ordered) {
    const phases = workflowActivityPhases(run);
    const id = workflowItemId(run.id);
    const title = line(run.name, 512);
    const parent = Object.freeze({ providerId: input.providerId, itemId: id });
    const live = !isWorkflowRunFinished(run.state);
    items.push(
      withActivityRevision({
        id,
        kind: "workflow" as const,
        title,
        status: WORKFLOW_STATUS[run.state],
        startedAt: run.startedAt,
        updatedAt: lastUpdate(run),
        ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
        summary: line(workflowSummary(run, phases), 4096),
        phases: Object.freeze(phases),
        ...shownPhase(run.currentPhase, phases),
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
      }),
    );
    if (!live) continue;
    const queued = run.agents
      .filter((agent) => agent.state === "queued" && !input.visibleRunIds.has(agent.runId))
      .slice(0, Math.min(QUEUED_ROWS_PER_WORKFLOW, budget));
    budget -= queued.length;
    for (const agent of queued) {
      const label = line(agent.label, 512);
      items.push(
        withActivityRevision({
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
        }),
      );
    }
  }
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
