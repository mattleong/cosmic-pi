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

export interface GroupSummary {
  readonly items: number;
  readonly running: number;
  readonly pending: number;
  readonly queued: number;
  readonly stopping: number;
  readonly terminal: number;
  readonly stopped: number;
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

export const plannedLabels = (summary: Pick<GroupSummary, "planned" | "unrun">): string[] => [
  ...(summary.planned ? [`${summary.planned} planned`] : []),
  ...(summary.unrun ? [`${summary.unrun} not run`] : []),
];

export const activeWorkLabels = (summary: GroupSummary): string[] => [
  ...(summary.running ? [`${summary.running} running`] : []),
  ...(summary.pending > summary.queued ? [`${summary.pending - summary.queued} starting`] : []),
  ...(summary.queued ? [`${summary.queued} queued`] : []),
  ...(summary.stopping ? [`${summary.stopping} stopping`] : []),
];

export const endedWorkLabels = (summary: Pick<GroupSummary, "stopped" | "skipped">): string[] => [
  ...(summary.stopped ? [`${summary.stopped} stopped`] : []),
  ...(summary.skipped ? [`${summary.skipped} skipped`] : []),
];

export const finishedWork = (summary: GroupSummary): number =>
  Math.max(0, summary.terminal - summary.stopped - summary.skipped - summary.attention.failed);

export const groupSummaryLabels = (summary: GroupSummary): string[] => [
  ...compactNotices(summary.attention),
  ...activeWorkLabels(summary),
  ...endedWorkLabels(summary),
  ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
  ...plannedLabels(summary),
];

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
export type PhaseCounts = Readonly<Record<PhaseState, number>>;

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

export const declaredPlanned = (
  workflow: ActivityRow,
  count: number | undefined,
  visible: Pick<GroupSummary, "planned" | "unrun">,
): Pick<GroupSummary, "planned" | "unrun"> => {
  if (count === undefined) return { planned: visible.planned, unrun: visible.unrun };
  return isFinished(workflow) ? { planned: 0, unrun: count } : { planned: count, unrun: 0 };
};

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
