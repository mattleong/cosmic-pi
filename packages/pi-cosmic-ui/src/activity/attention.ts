import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { managerActivityLabel } from "../manager/chrome.ts";
import type { ActivityRow } from "./model.ts";
import type { ActivityItem } from "./protocol.ts";

export function activityAttention(item: ActivityItem): "user" | "parent" | "blocked" | undefined {
  if (item.status === "needs-input") return item.inputTarget;
  return item.status === "blocked" ? "blocked" : undefined;
}

export const needsYou = (rows: readonly ActivityRow[]): readonly ActivityRow[] =>
  Arr.filter(rows, (row) => activityAttention(row) === "user");

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

export function activityStatus(item: ActivityItem): string {
  if (item.status === "needs-input")
    return item.inputTarget === "user" ? "waiting for you" : "waiting for parent";
  if (item.status === "blocked")
    return item.blockedReason ? blockedLabels[item.blockedReason] : "blocked";
  if (item.status === "cancelled")
    return item.kind === "question" ? "cancelled" : managerActivityLabel("stopped");
  if (item.status === "pending")
    return item.kind === "question" || activityQueued(item)
      ? "queued"
      : managerActivityLabel("pending");
  return managerActivityLabel(item.status);
}

export interface ActivityAttentionCounts {
  readonly user: number;
  readonly parent: number;
  readonly blocked: number;
  readonly failed: number;
}

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

export const activityAttentionLabels = (counts: ActivityAttentionCounts): string[] =>
  Arr.filter(
    [
      counts.user ? `${counts.user} ${counts.user === 1 ? "needs" : "need"} your input` : "",
      counts.parent ? `${counts.parent} waiting for parent` : "",
      counts.blocked ? `${counts.blocked} blocked` : "",
      counts.failed ? `${counts.failed} failed` : "",
    ],
    Str.isNonEmpty,
  );

export const compactNotices = (attention: ActivityAttentionCounts): string[] => [
  ...(attention.user ? [`${attention.user} ${attention.user === 1 ? "needs" : "need"} you`] : []),
  ...(attention.parent ? [`${attention.parent} waiting`] : []),
  ...(attention.blocked ? [`${attention.blocked} blocked`] : []),
  ...(attention.failed ? [`${attention.failed} failed`] : []),
];
