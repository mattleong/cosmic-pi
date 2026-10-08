import {
  activityAttentionCounts,
  activityAttentionLabels,
  activityPlanned,
  activityQueued,
  addAttention,
  compactNotices,
  type ActivityAttentionCounts,
} from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";

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
  /** Cancelled work skipped before it started; disjoint from `stopped`. */
  readonly skipped: number;
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
  skipped: 0,
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
  skipped: left.skipped + right.skipped,
  awaited: left.awaited + right.awaited,
  planned: left.planned + right.planned,
  unrun: left.unrun + right.unrun,
  attention: addAttention(left.attention, right.attention),
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
  stopped: Number(row.status === "cancelled" && row.skipped !== true),
  skipped: Number(row.status === "cancelled" && row.skipped === true),
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

/** Work that is under way or waiting to start. */
export const activeWorkLabels = (summary: GroupSummary): string[] => [
  ...(summary.running ? [`${summary.running} running`] : []),
  ...(summary.pending > summary.queued ? [`${summary.pending - summary.queued} starting`] : []),
  ...(summary.queued ? [`${summary.queued} queued`] : []),
  ...(summary.stopping ? [`${summary.stopping} stopping`] : []),
];

/** Work that ended without finishing: stopped, then skipped before it started. */
export const endedWorkLabels = (summary: Pick<GroupSummary, "stopped" | "skipped">): string[] => [
  ...(summary.stopped ? [`${summary.stopped} stopped`] : []),
  ...(summary.skipped ? [`${summary.skipped} skipped`] : []),
];

/** Settled work that succeeded: never stopped, skipped or failed work. */
export const finishedWork = (summary: GroupSummary): number =>
  Math.max(0, summary.terminal - summary.stopped - summary.skipped - summary.attention.failed);

/**
 * A section header's counts: attention first, in the widget's short words, so a header clipped
 * to the list's width keeps what needs someone; then work under way, stopped and skipped work and
 * the rest.
 */
export const groupSummaryLabels = (summary: GroupSummary): string[] => [
  ...compactNotices(summary.attention),
  ...activeWorkLabels(summary),
  ...endedWorkLabels(summary),
  ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
  ...plannedLabels(summary),
];

/**
 * Every work state with a count, for details. Finished counts only work that succeeded, so
 * stopped, skipped and failed work is never called finished.
 */
export const workStateLabels = (summary: GroupSummary): string[] => {
  const finished = finishedWork(summary);
  return [
    ...activeWorkLabels(summary),
    ...activityAttentionLabels(summary.attention),
    ...(finished ? [`${finished} finished`] : []),
    ...endedWorkLabels(summary),
  ];
};

export type PhaseState = "pending" | "running" | "done" | "failed" | "stopped" | "skipped";
/** Phases in each state. */
export type PhaseCounts = Readonly<Record<PhaseState, number>>;

/**
 * Settled phases, for history placement only. Done, failed, stopped and skipped phases have all
 * settled; display counts keep them apart, so only done phases count as done.
 */
export const phaseFinished = (state: PhaseState): boolean =>
  state !== "pending" && state !== "running";

export const countPhases = (states: readonly PhaseState[]) => {
  const counts = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    skipped: 0,
  } satisfies Record<PhaseState, number>;
  for (const state of states) counts[state]++;
  return counts;
};

/**
 * Done phases out of all phases, then stopped and skipped phases, which never count as done.
 * Rows leave failed phases to their members' failure notices; details name them after the done
 * count when `failed` is set.
 */
export const phaseCountLabels = (
  counts: PhaseCounts,
  total: number,
  noun: string,
  failed = false,
): string[] => [
  `${counts.done}/${total} ${noun}`,
  ...(failed && counts.failed ? [`${counts.failed} failed`] : []),
  ...(counts.stopped ? [`${counts.stopped} stopped`] : []),
  ...(counts.skipped ? [`${counts.skipped} skipped`] : []),
];

/** Wall span across started members, not summed effort; queued members have not started. */
export function workflowMemberSpan(
  members: readonly ActivityRow[],
  now: number | undefined,
): number | undefined {
  let start = Infinity;
  let end = 0;
  for (const row of members) {
    if (row.startedAt === undefined) continue;
    const until = isFinished(row) ? row.endedAt : now;
    if (until === undefined) return undefined;
    start = Math.min(start, row.startedAt);
    end = Math.max(end, until);
  }
  return start === Infinity ? undefined : Math.max(0, end - start);
}

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
 * Derives one phase's state from its summary, which carries the producer's own counts when it
 * sends them, and the workflow row. `current` is the index of the workflow's current phase. The
 * current phase of a live workflow stays running between its sequential members. Settled work
 * that was all skipped is skipped, work that all stopped or was skipped is stopped, and settled
 * work with any failure is failed, never done. A phase without work that the workflow passed, or
 * ended before reaching, is skipped; while the workflow is live, planned agents keep it pending,
 * since the script can still call them.
 */
export function phaseState(
  workflow: ActivityRow,
  index: number,
  current: number | undefined,
  progress: GroupSummary,
): PhaseState {
  const live = !isFinished(workflow);
  if (progress.terminal < progress.items) return "running";
  if (progress.items > 0) {
    if (live && current === index) return "running";
    if (progress.skipped === progress.items) return "skipped";
    if (progress.stopped + progress.skipped === progress.items) return "stopped";
    return progress.attention.failed > 0 ? "failed" : "done";
  }
  if (index === current && live) return "running";
  const passed = current !== undefined && index < current;
  if (!live || (passed && progress.planned === 0)) return "skipped";
  return "pending";
}
