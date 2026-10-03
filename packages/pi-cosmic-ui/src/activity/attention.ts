import { managerActivityLabel } from "../manager/chrome.ts";
import type { ActivityItem } from "./protocol.ts";

/** Roles and reasons come from producers, never from provider identity or display text. */
export function activityAttention(item: ActivityItem): "user" | "parent" | "blocked" | undefined {
  if (item.status === "needs-input") return item.inputTarget;
  return item.status === "blocked" ? "blocked" : undefined;
}

const blockedLabels = {
  "parent-review": "parent needs to review",
  "file-access-review": "parent needs to review file access",
  "file-access": "waiting for file access",
  "write-containment": "pausing writes for safety",
} as const;

/** Work that has not started yet, such as a workflow agent waiting for a slot. */
export const activityQueued = (item: ActivityItem): boolean =>
  item.status === "pending" &&
  item.startedAt === undefined &&
  (item.kind === "agent" || item.kind === "command");

/** The shared state word; questionnaires are queued and cancelled, work starts and is stopped. */
export function activityStatus(item: ActivityItem): string {
  const attention = activityAttention(item);
  if (attention === "user") return "waiting for you";
  if (attention === "parent") return "waiting for parent";
  if (item.status === "blocked")
    return item.blockedReason ? blockedLabels[item.blockedReason] : "blocked";
  if (item.status === "needs-input") return managerActivityLabel("waiting");
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

export function activityAttentionTotals(items: readonly ActivityItem[]): ActivityAttentionCounts {
  const total = { user: 0, parent: 0, blocked: 0, failed: 0 };
  for (const item of items) {
    const counts = activityAttentionCounts(item);
    total.user += counts.user;
    total.parent += counts.parent;
    total.blocked += counts.blocked;
    total.failed += counts.failed;
  }
  return total;
}

export const activityAttentionLabels = (counts: ActivityAttentionCounts): string[] =>
  [
    counts.user ? `${counts.user} ${counts.user === 1 ? "needs" : "need"} your input` : "",
    counts.parent ? `${counts.parent} waiting for parent` : "",
    counts.blocked ? `${counts.blocked} blocked` : "",
    counts.failed ? `${counts.failed} failed` : "",
  ].filter(Boolean);
