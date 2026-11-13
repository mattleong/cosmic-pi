import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  managerActivityColor,
  managerActivityLabel,
  managerNoticeColor,
  type ManagerStatusColor,
} from "../manager/chrome.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityItem } from "./protocol.ts";

export function activityAttention(item: ActivityItem): "user" | "parent" | "blocked" | undefined {
  if (item.status === "needs-input") return item.inputTarget;
  return item.status === "blocked" ? "blocked" : undefined;
}

// The widget and manager ask for each published row snapshot on every frame.
export const needsYou = Fn.memoize((rows: readonly ActivityRow[]): readonly ActivityRow[] =>
  Arr.filter(rows, (row) => activityAttention(row) === "user"),
);

const blockedLabels = {
  "parent-review": "parent needs to review",
  "file-access-review": "parent needs to review file access",
  "file-access": "waiting for file access",
  "write-containment": "pausing writes for safety",
} as const;

export const activityQueued = (item: ActivityItem): boolean =>
  item.status === "pending" &&
  item.startedAt === undefined &&
  (item.kind === "agent" || item.kind === "command");

/**
 * Whether a source can still produce output to follow: work that has started and not finished.
 * Queued work hasn't started, and a question's detail never streams.
 */
export const activityCanFollow = (row: ActivityRow): boolean =>
  row.retained !== true && row.kind !== "question" && row.status !== "pending" && !isFinished(row);

/** Queued work, or a question waiting its turn: both read and mark as queued. */
export const activityAwaitingTurn = (item: ActivityItem): boolean =>
  activityQueued(item) || (item.kind === "question" && item.status === "pending");

export function activityStatus(item: ActivityItem): string {
  if (item.status === "needs-input")
    return item.inputTarget === "user" ? "needs your input" : "waiting for reply";
  if (item.status === "blocked")
    return item.blockedReason ? blockedLabels[item.blockedReason] : "blocked";
  if (item.status === "cancelled")
    return item.kind === "question" ? "cancelled" : managerActivityLabel("stopped");
  if (item.status === "pending")
    return activityAwaitingTurn(item) ? "queued" : managerActivityLabel("pending");
  return managerActivityLabel(item.status);
}

export interface ActivityAttentionCounts {
  readonly user: number;
  readonly parent: number;
  readonly blocked: number;
  readonly failed: number;
}

export const emptyAttention: ActivityAttentionCounts = {
  user: 0,
  parent: 0,
  blocked: 0,
  failed: 0,
};

export function activityAttentionCounts(item: ActivityItem): ActivityAttentionCounts {
  const attention = activityAttention(item);
  return {
    user: Number(attention === "user"),
    parent: Number(attention === "parent"),
    blocked: Number(attention === "blocked"),
    failed: Number(item.status === "failed"),
  };
}

export const addAttention = (
  left: ActivityAttentionCounts,
  right: ActivityAttentionCounts,
  sign = 1,
): ActivityAttentionCounts => ({
  user: left.user + sign * right.user,
  parent: left.parent + sign * right.parent,
  blocked: left.blocked + sign * right.blocked,
  failed: left.failed + sign * right.failed,
});

/** Blocked or failed work is a problem; input and parent waits only await a decision. */
export const activityAttentionColor = (counts: ActivityAttentionCounts) =>
  counts.blocked > 0 || counts.failed > 0 ? "warning" : managerNoticeColor("attention");

/** Each attention count with its words and the tone its row glyphs use. */
export const activityAttentionParts = (
  counts: ActivityAttentionCounts,
): ReadonlyArray<{ readonly label: string; readonly tone: ManagerStatusColor }> => {
  const waiting = managerNoticeColor("attention");
  return Arr.filter(
    [
      {
        label: counts.user
          ? `${counts.user} ${counts.user === 1 ? "needs" : "need"} your input`
          : "",
        tone: waiting,
      },
      { label: counts.parent ? `${counts.parent} waiting for reply` : "", tone: waiting },
      { label: counts.blocked ? `${counts.blocked} blocked` : "", tone: "warning" as const },
      {
        label: counts.failed ? `${counts.failed} failed` : "",
        tone: managerActivityColor("failed"),
      },
    ],
    (part) => Str.isNonEmpty(part.label),
  );
};

export const activityAttentionLabels = (counts: ActivityAttentionCounts): string[] =>
  Arr.map(activityAttentionParts(counts), (part) => part.label);
