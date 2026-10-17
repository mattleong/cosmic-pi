import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  piKeybindingsFixture,
  plainTheme,
  tuiFixture,
  yieldUntil,
} from "pi-cosmic-core/testing";
import {
  ACTIVITY_EVENT,
  ActivitySnapshotSchema,
  activityKey,
  registerActivityProvider,
  type ActivityItem,
  type ActivityProviderOptions,
} from "../src/activity/protocol.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import type { ActivityError } from "../src/activity/service.ts";
import { createActivityHost } from "../src/boundary/host-activity.ts";
import { ActivityComponent } from "../src/activity/component.ts";
import { fakeCustomSurfaceHost } from "../src/testing/custom-surface.ts";
import { connectedActivityService } from "./support/activity.ts";
import { eventBus } from "./support/host.ts";

type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];
const item = (id = "a"): ActivityItem => ({
  id,
  title: "Work",
  kind: "agent",
  status: "running",
  revision: "1",
});
function harness(mode: "normal" | "deferred" | "throws-after-factory" = "normal") {
  const { events: bus, emitted } = eventBus();
  const work: Array<Effect.Effect<void, ActivityError>> = [];
  const host = createActivityHost(extensionApiFixture({ events: bus }), (effect) => {
    work.push(effect);
  });
  const notifications: string[] = [];
  const tui = tuiFixture();
  const keybindings = piKeybindingsFixture();
  let widget: string[] | Widget;
  let mountedWidget: (Component & { dispose?: () => void }) | undefined;
  const mountWidget = () => {
    if (!Predicate.isFunction(widget)) throw new Error("No widget factory");
    mountedWidget = widget(tui, plainTheme);
  };
  const surface = fakeCustomSurfaceHost({ columns: 80, rows: 24, theme: plainTheme, keybindings });
  const ctx = extensionContextFixture({
    mode: "tui",
    sessionManager: { getSessionId: () => "session" },
    ui: {
      setWidget(_key: string, value: string[] | Widget) {
        if (!value) {
          mountedWidget?.dispose?.();
          widget = undefined;
          return;
        }
        widget = value;
        if (mode !== "deferred") mountWidget();
        if (mode === "throws-after-factory") throw new Error("installation failed after factory");
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
        snapshot: () => [item()],
        invoke: () => Promise.resolve(),
        ...overrides,
      }),
    host,
    ctx,
    surface,
    envelopes: () => emitted.filter(({ name }) => name === ACTIVITY_EVENT).map(({ data }) => data),
    service,
    rows: () => rows,
    drain,
    openManager,
    mountWidget,
    notifications,
  };
}

describe("activity host lifecycle", () => {
  it.effect("suppresses late action warnings after the host is replaced", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const completion = deferredPromise();
      let invoked = false;
      const provider = fixture.register({
        snapshot: () => [{ ...item(), actions: [{ id: "stop", label: "Stop", handoff: false }] }],
        invoke: () => {
          invoked = true;
          return completion.promise;
        },
      });
      yield* fixture.drain();
      const { component } = yield* fixture.openManager();
      component.render(120);
      component.handleInput("x");
      const action = yield* fixture.drain().pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => invoked);
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      completion.reject(new Error("late action failure"));
      yield* Fiber.join(action);
      expect(fixture.notifications).toEqual([]);
      provider.dispose();
    }),
  );
  it.effect("reports current action failures and discards actions queued before retirement", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      let attempts = 0;
      const provider = fixture.register({
        snapshot: () => [{ ...item(), actions: [{ id: "stop", label: "Stop", handoff: false }] }],
        invoke: () => {
          attempts++;
          return Promise.reject(new Error("unavailable"));
        },
      });
      yield* fixture.drain();
      const { component } = yield* fixture.openManager();
      component.render(120);
      component.handleInput("x");
      yield* fixture.drain();
      expect(attempts).toBe(1);
      expect(fixture.notifications).toHaveLength(1);
      component.handleInput("x");
      fixture.host.deactivate();
      yield* fixture.drain();
      expect(attempts).toBe(1);
      expect(fixture.notifications).toHaveLength(1);
      provider.dispose();
    }),
  );
  it.effect("runs manager actions in place unless the producer hands off to its own UI", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const invoked: string[] = [];
      const provider = fixture.register({
        snapshot: () => [
          {
            ...item("flow"),
            actions: [{ id: "stop", label: "Stop agent", handoff: false }],
          },
          {
            ...item("asking"),
            parent: { providerId: "agents", itemId: "flow" },
            actions: [{ id: "reply", label: "Reply", handoff: true }],
          },
        ],
        invoke: (itemId, actionId) => {
          invoked.push(`${itemId}:${actionId}`);
          return Promise.resolve();
        },
      });
      yield* fixture.drain();
      const { open, component } = yield* fixture.openManager();
      component.render(120);
      expect(component.shell.state.selectedId).toBe(activityKey("agents", "flow"));
      component.handleInput("x");
      yield* fixture.drain();
      expect(invoked).toEqual(["flow:stop"]);
      expect(fixture.surface.overlays).toEqual([component]);
      component.handleInput("j");
      component.render(120);
      expect(component.shell.state.selectedId).toBe(activityKey("agents", "asking"));
      component.handleInput("m");
      expect(fixture.surface.overlays).toEqual([]);
      yield* Fiber.join(open);
      expect(invoked).toEqual(["flow:stop", "asking:reply"]);
      provider.dispose();
    }),
  );
  it.effect("acknowledges a mounted valid widget and immediately revokes on teardown", () =>
    Effect.gen(function* () {
      const fixture = harness("deferred");
      const service = yield* fixture.service();
      const availability: boolean[] = [];
      const provider = fixture.register({
        onAvailability: (value) => {
          availability.push(value);
        },
      });
      fixture.host.activate(fixture.ctx, service);
      yield* fixture.drain();
      expect(provider.isAvailable()).toBe(false);
      fixture.mountWidget();
      yield* fixture.drain();
      expect(provider.isAvailable()).toBe(true);
      fixture.host.deactivate();
      expect(provider.isAvailable()).toBe(false);
      expect(availability).toEqual([true, false]);
      provider.dispose();
    }),
  );
  it.effect("does not acknowledge a factory invoked by a failing setWidget", () =>
    Effect.gen(function* () {
      const fixture = harness("throws-after-factory");
      const service = yield* fixture.service();
      const provider = fixture.register();
      fixture.host.activate(fixture.ctx, service);
      yield* fixture.drain();
      expect(provider.isAvailable()).toBe(false);
      provider.dispose();
    }),
  );
  it.effect("rejects captured registration replay after same-session host replacement", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const first = yield* fixture.service();
      const provider = fixture.register();
      fixture.host.activate(fixture.ctx, first);
      yield* fixture.drain();
      const captured = fixture.envelopes()[0];
      provider.dispose();
      yield* fixture.drain();
      const replacement = yield* fixture.service();
      fixture.host.activate(fixture.ctx, replacement);
      fixture.bus.emit(ACTIVITY_EVENT, captured);
      yield* fixture.drain();
      expect(fixture.rows()).toEqual([]);
      const fresh = fixture.register({ snapshot: () => [item("fresh")] });
      yield* fixture.drain();
      expect(fresh.isAvailable()).toBe(true);
      expect(fixture.rows()[0]?.id).toBe("fresh");
      fresh.dispose();
    }),
  );
  it.effect("redacts summary and action secrets before publishing to other extensions", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const provider = fixture.register({
        snapshot: () => [
          {
            ...item(),
            title: "token=private-value",
            summary: "password=hunter2",
            actions: [
              { id: "stop", label: "secret=do-not-leak", confirmation: "credential=private-value" },
            ],
          },
        ],
      });
      yield* fixture.drain();
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ items: ActivitySnapshotSchema })),
      )(fixture.envelopes());
      const broadcast = decoded
        .flatMap((event) =>
          event.items.flatMap((activity) => [
            activity.title,
            activity.summary,
            activity.detail,
            ...(activity.actions ?? []).flatMap((action) => [action.label, action.confirmation]),
          ]),
        )
        .join("\n");
      expect(broadcast).not.toContain("private-value");
      expect(broadcast).not.toContain("hunter2");
      expect(broadcast).not.toContain("do-not-leak");
      provider.dispose();
    }),
  );
});
