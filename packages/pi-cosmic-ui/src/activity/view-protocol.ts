export const ACTIVITY_VIEW_DISCOVER = "cosmic-ui:activity:view:discover:v1";
export type ActivitySection = "workflows" | "subagents" | "tasks";
export interface ActivityViewCapability {
  /** False only before admission. Rejection must never trigger a second manager opening. */
  readonly open: (section: ActivitySection, signal?: AbortSignal) => Promise<boolean>;
}
export { discoverActivityView } from "../boundary/host-activity-view.ts";
