import * as Arr from "effect/Array";
import {
  activityAttentionCounts,
  activityAttentionLabels,
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
  readonly paused: number;
  readonly terminal: number;
  readonly stopped: number;
  readonly awaited: number;
  readonly attention: ActivityAttentionCounts;
}

const emptyAttention: ActivityAttentionCounts = { user: 0, parent: 0, blocked: 0, failed: 0 };
export const emptyGroupSummary: GroupSummary = {
  items: 0,
  running: 0,
  pending: 0,
  queued: 0,
  stopping: 0,
  paused: 0,
  terminal: 0,
  stopped: 0,
  awaited: 0,
  attention: emptyAttention,
};

export const addGroupSummaries = (left: GroupSummary, right: GroupSummary): GroupSummary => ({
  items: left.items + right.items,
  running: left.running + right.running,
  pending: left.pending + right.pending,
  queued: left.queued + right.queued,
  stopping: left.stopping + right.stopping,
  paused: left.paused + right.paused,
  terminal: left.terminal + right.terminal,
  stopped: left.stopped + right.stopped,
  awaited: left.awaited + right.awaited,
  attention: addAttention(left.attention, right.attention),
});

const rowSummary = (row: ActivityRow): GroupSummary => ({
  items: 1,
  running: Number(row.status === "running"),
  pending: Number(row.status === "pending"),
  queued: Number(activityQueued(row) || (row.kind === "question" && row.status === "pending")),
  stopping: Number(row.status === "stopping"),
  paused: Number(row.status === "paused"),
  terminal: Number(isFinished(row)),
  stopped: Number(row.status === "cancelled"),
  awaited: Number(row.awaited === true),
  attention: activityAttentionCounts(row),
});

export const summarizeGroup = (rows: readonly ActivityRow[]): GroupSummary =>
  Arr.reduce(rows, emptyGroupSummary, (total, row) => addGroupSummaries(total, rowSummary(row)));

export const activeWorkLabels = (summary: GroupSummary): string[] => [
  ...(summary.running ? [`${summary.running} running`] : []),
  ...(summary.pending > summary.queued ? [`${summary.pending - summary.queued} starting`] : []),
  ...(summary.queued ? [`${summary.queued} queued`] : []),
  ...(summary.stopping ? [`${summary.stopping} stopping`] : []),
  ...(summary.paused ? [`${summary.paused} paused`] : []),
];

export const endedWorkLabels = (summary: Pick<GroupSummary, "stopped">): string[] =>
  summary.stopped ? [`${summary.stopped} stopped`] : [];

const finishedWork = (summary: GroupSummary): number =>
  Math.max(0, summary.terminal - summary.stopped - summary.attention.failed);

export const groupSummaryLabels = (summary: GroupSummary): string[] => [
  ...compactNotices(summary.attention),
  ...activeWorkLabels(summary),
  ...endedWorkLabels(summary),
  ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
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
