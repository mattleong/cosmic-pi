import {
  workflowNotificationWakesAgent,
  type SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";

export type WorkflowRunHandoff = "now" | "next-turn";

export interface WorkflowRunObserver {
  readonly opened: (runId: string) => void;
  readonly closed: (runId: string, handoff: WorkflowRunHandoff) => void;
}

export const notificationHandoff = (
  notification: SubagentWorkflowNotification | undefined,
): WorkflowRunHandoff =>
  notification && !workflowNotificationWakesAgent(notification) ? "next-turn" : "now";
