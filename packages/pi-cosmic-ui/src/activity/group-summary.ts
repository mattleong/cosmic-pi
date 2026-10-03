import {
  activityAttentionCounts,
  activityAttentionLabels,
  activityPlanned,
  activityQueued,
} from "./attention.ts";
import type { ActivityAttentionCounts } from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityPhase } from "./protocol.ts";

/**
 * Work in a branch, each source counted once; workflow rows are containers, not work. Planned
 * rows are declarations, not work: they count only in `planned` (still possible) or `unrun`
 * (their owner ended without starting them), so they never make a phase running or done.
 */
export interface GroupSummary {
  readonly items: number;
  readonly running: number;
  readonly pending: number;
  /** Pending work that has not started and queued questionnaires; included in `pending`. */
  readonly queued: number;
  readonly stopping: number;
  readonly terminal: number;
  readonly stopped: number;
  readonly awaited: number;
  readonly planned: number;
  readonly unrun: number;
  readonly attention: ActivityAttentionCounts;
}

const emptyAttention: ActivityAttentionCounts = { user: 0, parent: 0, blocked: 0, failed: 0 };
export const emptyGroupSummary: GroupSummary = {
  items: 0,
  running: 0,
  pending: 0,
  queued: 0,
  stopping: 0,
  terminal: 0,
  stopped: 0,
  awaited: 0,
  planned: 0,
  unrun: 0,
  attention: emptyAttention,
};

export const addGroupSummaries = (left: GroupSummary, right: GroupSummary): GroupSummary => ({
  items: left.items + right.items,
  running: left.running + right.running,
  pending: left.pending + right.pending,
  queued: left.queued + right.queued,
  stopping: left.stopping + right.stopping,
  terminal: left.terminal + right.terminal,
  stopped: left.stopped + right.stopped,
  awaited: left.awaited + right.awaited,
  planned: left.planned + right.planned,
  unrun: left.unrun + right.unrun,
  attention: {
    user: left.attention.user + right.attention.user,
    parent: left.attention.parent + right.attention.parent,
    blocked: left.attention.blocked + right.attention.blocked,
    failed: left.attention.failed + right.attention.failed,
  },
});

const plannedSummary = (row: ActivityRow): GroupSummary => ({
  ...emptyGroupSummary,
  planned: Number(!isFinished(row)),
  unrun: Number(isFinished(row)),
});

const workSummary = (row: ActivityRow): GroupSummary => ({
  items: 1,
  running: Number(row.status === "running"),
  pending: Number(row.status === "pending"),
  queued: Number(activityQueued(row) || (row.kind === "question" && row.status === "pending")),
  stopping: Number(row.status === "stopping"),
  terminal: Number(isFinished(row)),
  stopped: Number(row.status === "cancelled"),
  awaited: Number(row.awaited === true),
  planned: 0,
  unrun: 0,
  attention: activityAttentionCounts(row),
});

const rowSummary = (row: ActivityRow): GroupSummary =>
  activityPlanned(row) ? plannedSummary(row) : workSummary(row);

export const summarizeGroup = (rows: readonly ActivityRow[]): GroupSummary =>
  rows.reduce((total, row) => addGroupSummaries(total, rowSummary(row)), emptyGroupSummary);

/** Planned and never-run declarations, kept apart from work progress. */
export const plannedLabels = (summary: Pick<GroupSummary, "planned" | "unrun">): string[] => [
  ...(summary.planned ? [`${summary.planned} planned`] : []),
  ...(summary.unrun ? [`${summary.unrun} not run`] : []),
];

export const groupSummaryLabels = (summary: GroupSummary): string[] => [
  ...(summary.running ? [`${summary.running} running`] : []),
  ...(summary.pending > summary.queued ? [`${summary.pending - summary.queued} starting`] : []),
  ...(summary.queued ? [`${summary.queued} queued`] : []),
  ...(summary.stopping ? [`${summary.stopping} stopping`] : []),
  ...(summary.stopped ? [`${summary.stopped} stopped`] : []),
  ...activityAttentionLabels(summary.attention),
  ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
  ...plannedLabels(summary),
];

export type PhaseState = "pending" | "running" | "done" | "stopped" | "skipped";

/** Done, stopped and skipped phases all count toward a workflow's finished phases. */
export const phaseFinished = (state: PhaseState): boolean =>
  state === "done" || state === "stopped" || state === "skipped";

/** The work and planned declarations a phase state is derived from. */
type PhaseProgress = Pick<GroupSummary, "items" | "terminal" | "stopped" | "planned">;

/**
 * The producer's own work count when it sends one. Retention, row caps and provider eviction can
 * hide finished members, so visible rows alone would show a phase that ran as skipped.
 */
export const phaseProgress = (phase: ActivityPhase, members: GroupSummary): PhaseProgress =>
  phase.work
    ? {
        items: phase.work.items,
        terminal: phase.work.finished,
        stopped: phase.work.stopped,
        planned: members.planned,
      }
    : members;

/**
 * Planned declarations under a workflow: the producer's own `count` when it sends one, since it
 * may publish only some planned rows and retention can drop the rest, otherwise the `visible`
 * planned rows. Once the workflow ends, what was planned was never run.
 */
export const declaredPlanned = (
  workflow: ActivityRow,
  count: number | undefined,
  visible: Pick<GroupSummary, "planned" | "unrun">,
): Pick<GroupSummary, "planned" | "unrun"> => {
  if (count === undefined) return { planned: visible.planned, unrun: visible.unrun };
  return isFinished(workflow) ? { planned: 0, unrun: count } : { planned: count, unrun: 0 };
};

/**
 * Derives one phase's state from its progress and the workflow row. `current` is the index of the
 * workflow's current phase. The current phase of a live workflow stays running between its
 * sequential members. A phase without work that the workflow passed, or ended before reaching,
 * is skipped; while the workflow is live, planned agents keep it pending, since the script can
 * still call them.
 */
export function phaseState(
  workflow: ActivityRow,
  index: number,
  current: number | undefined,
  progress: PhaseProgress,
): PhaseState {
  const live = !isFinished(workflow);
  if (progress.terminal < progress.items) return "running";
  if (progress.items > 0) {
    if (live && current === index) return "running";
    return progress.stopped === progress.items ? "stopped" : "done";
  }
  if (index === current && live) return "running";
  const passed = current !== undefined && index < current;
  if (!live || (passed && progress.planned === 0)) return "skipped";
  return "pending";
}
