export const ACTIVITY_VIEW_DISCOVER = "cosmic-ui:activity:view:discover:v1";
export type ActivitySection = "workflows" | "subagents" | "tasks";
export interface ActivityViewCapability {
  readonly open: (section: ActivitySection, signal?: AbortSignal) => Promise<boolean>;
}
export { discoverActivityView } from "../boundary/host-activity-view.ts";
