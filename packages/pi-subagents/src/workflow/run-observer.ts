import {
  workflowNotificationWakesAgent,
  type SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";

/**
 * Which agent run learns a closed run's outcome: the one under way or the one its notification
 * starts (`now`), or the next one, for a notice that waits for the next turn, such as a run the
 * user stopped or one an earlier activation left interrupted (`next-turn`).
 */
export type WorkflowRunHandoff = "now" | "next-turn";

/**
 * Follows which runs still need the main agent: a run opens when it starts or when a notice about
 * an interrupted one is posted, and closes once Pi accepted its notification or notice, or when it
 * needs neither. The application keeps workflows available while a run is open.
 */
export interface WorkflowRunObserver {
  readonly opened: (runId: string) => void;
  readonly closed: (runId: string, handoff: WorkflowRunHandoff) => void;
}

/** A run that needs no notification, such as one the main agent stopped, is handled now. */
export const notificationHandoff = (
  notification: SubagentWorkflowNotification | undefined,
): WorkflowRunHandoff =>
  notification && !workflowNotificationWakesAgent(notification) ? "next-turn" : "now";
