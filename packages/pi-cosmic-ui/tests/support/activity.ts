import { plainTheme } from "pi-cosmic-core/testing";
import { ActivityComponent, type ActivityComponentOptions } from "../../src/activity/component.ts";
import { groupedDetail } from "../../src/activity/grouped-detail.ts";
import { groupedActivityTree, type GroupedActivityRow } from "../../src/activity/grouped-tree.ts";
import type { ActivityRow } from "../../src/activity/model.ts";
import { activityKey, type ActivityItem } from "../../src/activity/protocol.ts";
import {
  ActivityService,
  type ActivityActionRequest,
  type ActivityDetailRequest,
  type ActivityServiceOptions,
} from "../../src/activity/service.ts";

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

/** The technical manager detail of the first grouped entry `pick` selects, with `loaded` output. */
export const groupedDetailOf = (
  rows: readonly ActivityRow[],
  pick: (entry: GroupedActivityRow) => boolean,
  loaded?: string,
) =>
  groupedDetail({
    selected: groupedActivityTree(rows).find(pick),
    theme: plainTheme,
    focused: true,
    now: 1000,
    loaded,
    actionPage: 0,
    technical: true,
  });

/** Mounts the activity manager with a plain theme and records close requests and detail loads. */
export const mountActivity = (
  snapshot: () => readonly ActivityRow[],
  {
    height = 12,
    ...options
  }: Pick<
    ActivityComponentOptions,
    "matchesKeybinding" | "presentation" | "invoke" | "initialSection"
  > & {
    readonly height?: number;
  } = {},
) => {
  const closed: Array<ActivityActionRequest | undefined> = [];
  /** Detail loads in request order, each with the callback that delivers its text. */
  const loads: Array<{ readonly request: ActivityDetailRequest; deliver(text: string): void }> = [];
  let cancels = 0;
  const component = new ActivityComponent({
    ...options,
    snapshot,
    theme: plainTheme,
    height: () => height,
    close: (request) => {
      closed.push(request);
    },
    requestRender: () => undefined,
    loadDetail: (request, deliver) => {
      loads.push({ request, deliver });
    },
    cancelDetail: () => {
      cancels++;
    },
  });
  return { component, closed, loads, cancels: () => cancels };
};

/** A service connected through `hooks` as the application layer connects it, minus the display clock; reports publications. */
export const connectedActivityService = (
  { publish, connect }: Pick<Required<ActivityServiceOptions>, "publish" | "connect">,
  published: (rows: readonly ActivityRow[]) => void = () => undefined,
) =>
  ActivityService.make({
    connect,
    publish: (rows, starting) => {
      published(rows);
      publish(rows, starting);
    },
  });
