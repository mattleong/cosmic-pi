import { plainTheme } from "pi-cosmic-core/testing";
import { ActivityComponent, type ActivityComponentOptions } from "../../src/activity/component.ts";
import type { ActivityRow } from "../../src/activity/model.ts";
import { activityKey, type ActivityItem } from "../../src/activity/protocol.ts";
import {
  ActivityService,
  type ActivityActionRequest,
  type ActivityDetailRequest,
  type ActivityServiceOptions,
} from "../../src/activity/service.ts";

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

export const withStatus = (
  row: ActivityRow,
  status: "pending" | "running" | "stopping" | "done" | "failed" | "cancelled",
  overrides: Partial<ActivityRow> = {},
): ActivityRow => Object.assign({ ...row }, { status }, overrides);

export const memberRow = (
  id: string,
  parent: ActivityRow,
  status: ActivityItem["status"] = "running",
  overrides: Partial<ActivityRow> = {},
): ActivityRow => activityRow(id, status, parent.id, overrides);

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
