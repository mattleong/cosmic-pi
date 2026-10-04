import { managerActivityLabel } from "../manager/chrome.ts";
import { isFinished } from "./model.ts";
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

/** Declared work that has not been requested; it is not queued and may never run. */
export const activityPlanned = (item: Pick<ActivityItem, "planned">): boolean =>
  item.planned === true;

/** Work that has not started yet, such as a workflow agent waiting for a slot. */
export const activityQueued = (item: ActivityItem): boolean =>
  !activityPlanned(item) &&
  item.status === "pending" &&
  item.startedAt === undefined &&
  (item.kind === "agent" || item.kind === "command");

/**
 * The shared state word; questionnaires are queued and cancelled, work starts and is stopped, or
 * is skipped before it starts.
 */
export function activityStatus(item: ActivityItem): string {
  // A planned item that ended never ran; its producer no longer intends to start it.
  if (activityPlanned(item)) return isFinished(item) ? "not run" : "planned";
  const attention = activityAttention(item);
  if (attention === "user") return "waiting for you";
  if (attention === "parent") return "waiting for parent";
  if (item.status === "blocked")
    return item.blockedReason ? blockedLabels[item.blockedReason] : "blocked";
  if (item.status === "needs-input") return managerActivityLabel("waiting");
  if (item.status === "cancelled")
    return item.kind === "question"
      ? "cancelled"
      : item.skipped === true
        ? "skipped"
        : managerActivityLabel("stopped");
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

/**
 * Short attention notices for branch rows and section headers: who must act ("needs you" for
 * human input, "waiting" for a parent agent's answer), then blocked and failed work.
 */
export const compactNotices = (attention: ActivityAttentionCounts): string[] => [
  ...(attention.user ? [`${attention.user} ${attention.user === 1 ? "needs" : "need"} you`] : []),
  ...(attention.parent ? [`${attention.parent} waiting`] : []),
  ...(attention.blocked ? [`${attention.blocked} blocked`] : []),
  ...(attention.failed ? [`${attention.failed} failed`] : []),
];
