import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  extensionApiFixture,
  extensionContextFixture,
  plainTheme,
  tuiFixture,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { ActivityComponent, type ActivityComponentOptions } from "../../src/activity/component.ts";
import type { ActivityRow } from "../../src/activity/model.ts";
import {
  ACTIVITY_EVENT,
  activityKey,
  registerActivityProvider,
  type ActivityDetail,
  type ActivityItem,
  type ActivityProviderOptions,
} from "../../src/activity/protocol.ts";
import { decodeActivityDetail, plainActivityDetail } from "../../src/activity/detail.ts";
import {
  ActivityService,
  type ActivityActionRequest,
  type ActivityDetailRequest,
  type ActivityError,
  type ActivityServiceOptions,
} from "../../src/activity/service.ts";
import { createActivityHost } from "../../src/boundary/host-activity.ts";
import { fakeCustomSurfaceHost } from "../../src/testing/custom-surface.ts";
import { eventBus } from "./host.ts";

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
  const loads: Array<{
    readonly request: ActivityDetailRequest;
    deliver(text: string): void;
    deliverDetail(detail: ActivityDetail): void;
  }> = [];
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
      loads.push({
        request,
        deliver: (text) => deliver(plainActivityDetail(text)),
        deliverDetail: (detail) => deliver(decodeActivityDetail(detail) ?? { sections: [] }),
      });
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

export const activityItem = (id = "a"): ActivityItem => ({
  id,
  title: "Work",
  kind: "agent",
  status: "running",
  revision: "1",
});

type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

/**
 * An Activity host on a fake TUI for session `session`. Submitted work queues until `drain`; the
 * widget mounts as it is installed unless `widget` defers or fails the installation.
 */
export function activityHostHarness(
  options: {
    readonly mode?: "tui" | "rpc";
    readonly run?: Parameters<typeof createActivityHost>[2];
    readonly widget?: "normal" | "deferred" | "throws-after-factory";
    readonly loadComponent?: Parameters<typeof createActivityHost>[3];
  } = {},
) {
  const { events: bus, emitted } = eventBus();
  const work: Array<Effect.Effect<void, ActivityError>> = [];
  const host = createActivityHost(
    extensionApiFixture({ events: bus }),
    (effect) => {
      work.push(effect);
    },
    options.run,
    options.loadComponent,
  );
  const notifications: string[] = [];
  const tui = tuiFixture();
  let widget: string[] | Widget;
  let mountedWidget: (Component & { dispose?: () => void }) | undefined;
  const mountWidget = () => {
    if (!Predicate.isFunction(widget)) throw new Error("No widget factory");
    mountedWidget = widget(tui, plainTheme);
  };
  const surface = fakeCustomSurfaceHost({ columns: 80, rows: 24 });
  const ctx = extensionContextFixture({
    mode: options.mode ?? "tui",
    sessionManager: { getSessionId: () => "session" },
    ui: {
      setWidget(_key: string, value: string[] | Widget) {
        if (!value) {
          mountedWidget?.dispose?.();
          widget = undefined;
          return;
        }
        widget = value;
        if (options.widget !== "deferred") mountWidget();
        if (options.widget === "throws-after-factory")
          throw new Error("installation failed after factory");
      },
      custom: surface.custom,
      notify(message) {
        notifications.push(message);
      },
    },
  });
  let rows: readonly ActivityRow[] = [];
  const service = () =>
    connectedActivityService(host.serviceOptions(), (next) => {
      rows = next;
    });
  const drain = () =>
    Effect.gen(function* () {
      while (work.length) yield* work.shift()!.pipe(Effect.ignore);
    });
  const openManager = () =>
    Effect.gen(function* () {
      const open = yield* host.open(ctx).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => surface.pendingMounts > 0);
      surface.mount();
      const component = surface.overlays[0];
      if (!(component instanceof ActivityComponent))
        throw new Error("Activity manager not mounted");
      return { open, component };
    });
  return {
    bus,
    register: (overrides: Partial<ActivityProviderOptions> = {}) =>
      registerActivityProvider(bus, {
        sessionId: "session",
        providerId: "agents",
        snapshot: () => [activityItem()],
        invoke: () => Promise.resolve(),
        ...overrides,
      }),
    host,
    ctx,
    surface,
    envelopes: () =>
      Arr.map(
        Arr.filter(emitted, ({ name }) => name === ACTIVITY_EVENT),
        ({ data }) => data,
      ),
    service,
    rows: () => rows,
    drain,
    openManager,
    mountWidget,
    notifications,
  };
}
