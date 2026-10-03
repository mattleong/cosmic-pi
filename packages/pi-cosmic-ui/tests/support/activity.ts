import { ActivityComponent, type ActivityComponentOptions } from "../../src/activity/component.ts";
import type { ActivityRow } from "../../src/activity/model.ts";
import { activityKey, type ActivityItem } from "../../src/activity/protocol.ts";
import type { ActivityActionRequest } from "../../src/activity/service.ts";

/** An agents-provider row; needs-input rows default to user input. */
export const activityRow = (
  id: string,
  status: ActivityItem["status"] = "running",
  parent?: string,
  overrides: Partial<ActivityRow> = {},
): ActivityRow => {
  const value: ActivityRow = {
    key: activityKey("agents", id),
    id,
    title: id,
    kind: "agent",
    ...(status === "needs-input" ? { status, inputTarget: "user" as const } : { status }),
    providerId: "agents",
    generation: 1,
    revision: "1",
  };
  if (parent) Object.assign(value, { parent: { providerId: "agents", itemId: parent } });
  return Object.assign(value, overrides);
};

/** The same live or finished row in another live or finished status. */
export const withStatus = (
  row: ActivityRow,
  status: "pending" | "running" | "stopping" | "done" | "failed" | "cancelled",
  overrides: Partial<ActivityRow> = {},
): ActivityRow => Object.assign({ ...row }, { status }, overrides);

/** A workflow row with ordered phase titles and an optional current phase. */
export const workflowRow = (
  id: string,
  phases: readonly string[] = [],
  status: ActivityItem["status"] = "running",
  phase?: string,
  overrides: Partial<ActivityRow> = {},
): ActivityRow => {
  const value = activityRow(id, status, undefined, {
    kind: "workflow",
    phases: phases.map((title) => ({ title })),
  });
  if (phase !== undefined) Object.assign(value, { phase });
  return Object.assign(value, overrides);
};

/** A workflow member placed in `phase`; queued placeholders are pending without a start time. */
export const memberRow = (
  id: string,
  workflow: ActivityRow,
  phase?: string,
  status: ActivityItem["status"] = "running",
  overrides: Partial<ActivityRow> = {},
): ActivityRow => {
  const value = activityRow(id, status, workflow.id);
  if (phase !== undefined) Object.assign(value, { phase });
  return Object.assign(value, overrides);
};

/** Mounts the activity manager with a plain theme and records close requests. */
export const mountActivity = (
  snapshot: () => readonly ActivityRow[],
  {
    height = 12,
    ...options
  }: Pick<
    ActivityComponentOptions,
    | "loadDetail"
    | "matchesKeybinding"
    | "presentation"
    | "cancelDetail"
    | "invoke"
    | "initialSection"
  > & {
    readonly height?: number;
  } = {},
) => {
  const closed: Array<ActivityActionRequest | undefined> = [];
  const component = new ActivityComponent({
    ...options,
    snapshot,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    height: () => height,
    close: (request) => {
      closed.push(request);
    },
    requestRender: () => undefined,
  });
  return { component, closed };
};
