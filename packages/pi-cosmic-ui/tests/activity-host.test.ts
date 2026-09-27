import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import {
  ACTIVITY_EVENT,
  ActivitySnapshotSchema,
  registerActivityProvider,
  type ActivityItem,
  type ActivityProviderOptions,
} from "../src/activity/protocol.ts";
import {
  ActivityService,
  type ActivityError,
  type ActivityServiceContract,
} from "../src/activity/service.ts";
import { makeActivityHost } from "../src/boundary/host-activity.ts";
import { screenViewport } from "../src/manager/viewport.ts";
import { fakeCustomSurfaceHost } from "../src/testing/custom-surface.ts";
import { eventBus } from "./support/host.ts";
import { SPINNER_FRAME_MS } from "../src/manager/chrome.ts";

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
  const host = makeActivityHost(extensionApiFixture({ events: bus }), (effect) => {
    work.push(effect);
  });
  let redraws = 0;
  const tui = opaqueFixture({
    terminal: { columns: 80, rows: 24 },
    requestRender() {
      redraws++;
    },
  });
  const keybindings = opaqueFixture({ matches: () => false, getKeys: () => [] });
  let widget: Widget;
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
      setWidget(_key: string, value: Widget) {
        if (!value) {
          mountedWidget?.dispose?.();
          widget = undefined;
          return;
        }
        widget = value;
        if (mode !== "deferred") mountWidget();
        if (mode === "throws-after-factory") throw new Error("installation failed after factory");
      },
      custom: surface.ctx.ui.custom,
      notify() {},
    },
  });
  const service = () =>
    Effect.gen(function* () {
      let connected: ActivityServiceContract | undefined;
      const value = yield* ActivityService.make({
        publish: (rows, starting) => {
          if (connected) host.publish(connected, rows, starting);
        },
        connect: (current) => {
          connected = current;
          return host.bind(current);
        },
      });
      return value;
    });
  const drain = () =>
    Effect.gen(function* () {
      while (work.length) yield* work.shift()!.pipe(Effect.ignore);
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
    drain,
    mountWidget,
    renderWidget: () => mountedWidget?.render(80) ?? [],
    redraws: () => redraws,
    pendingWork: () => work.length,
    disposeWidget: () => mountedWidget?.dispose?.(),
  };
}

describe("activity host lifecycle", () => {
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
  it.effect("renders launch metadata without rows and withdraws it on invalidation or revoke", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const service = yield* fixture.service();
      let starting = 2;
      const provider = fixture.register({ snapshot: () => [], starting: () => starting });
      fixture.host.activate(fixture.ctx, service);
      yield* fixture.drain();
      fixture.host.tick(service, 0);
      const first = fixture.renderWidget();
      expect(first).toHaveLength(1);
      expect(yield* service.snapshot).toEqual([]);
      starting = 3;
      provider.publish();
      yield* fixture.drain();
      expect(fixture.renderWidget()).toEqual(first);
      const beforeTick = fixture.redraws();
      fixture.host.tick(service, SPINNER_FRAME_MS);
      expect(fixture.redraws()).toBeGreaterThan(beforeTick);
      expect(fixture.renderWidget()).not.toEqual(first);
      fixture.host.tick(service, 0);
      starting = -1;
      provider.publish();
      yield* fixture.drain();
      expect(fixture.renderWidget()).toEqual([]);
      expect(provider.isAvailable()).toBe(false);
      starting = 2;
      provider.publish();
      yield* fixture.drain();
      expect(fixture.renderWidget()).toEqual(first);
      provider.dispose();
      yield* fixture.drain();
      expect(fixture.renderWidget()).toEqual([]);
      const afterRevoke = fixture.redraws();
      fixture.host.tick(service, SPINNER_FRAME_MS);
      expect(fixture.redraws()).toBe(afterRevoke);
      fixture.host.deactivate();
      const afterDeactivate = fixture.redraws();
      fixture.host.tick(service, 200);
      expect(fixture.redraws()).toBe(afterDeactivate);
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
  it.effect(
    "waits for mounting, restores fallback on disposal, and recovers invalid initial snapshots",
    () =>
      Effect.gen(function* () {
        const fixture = harness("deferred");
        const service = yield* fixture.service();
        let items = Array.from({ length: 513 }, (_, index) => item(String(index)));
        const provider = fixture.register({ snapshot: () => items });
        fixture.host.activate(fixture.ctx, service);
        expect(provider.isAvailable()).toBe(false);
        fixture.mountWidget();
        yield* fixture.drain();
        expect(provider.isAvailable()).toBe(false);
        items = [item()];
        provider.publish();
        yield* fixture.drain();
        expect(provider.isAvailable()).toBe(true);
        fixture.disposeWidget();
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
      expect(yield* replacement.snapshot).toEqual([]);
      const fresh = fixture.register({ snapshot: () => [item("fresh")] });
      yield* fixture.drain();
      expect(fresh.isAvailable()).toBe(true);
      expect((yield* replacement.snapshot)[0]?.id).toBe("fresh");
      fresh.dispose();
    }),
  );
  it.effect("re-handshakes a live provider without accepting the old host envelope", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const provider = fixture.register();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      yield* fixture.drain();
      const captured = fixture.envelopes()[0];
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const pending = fixture.pendingWork();
      fixture.bus.emit(ACTIVITY_EVENT, captured);
      expect(fixture.pendingWork()).toBe(pending);
      yield* fixture.drain();
      expect(provider.isAvailable()).toBe(true);
      provider.dispose();
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
          event.items.flatMap((item) => [
            item.title,
            item.summary,
            item.detail,
            ...(item.actions ?? []).flatMap((action) => [action.label, action.confirmation]),
          ]),
        )
        .join("\n");
      expect(broadcast).not.toContain("private-value");
      expect(broadcast).not.toContain("hunter2");
      expect(broadcast).not.toContain("do-not-leak");
      provider.dispose();
    }),
  );
  it.effect("resizes an open activity manager using the same frame allocation as its overlay", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const open = yield* fixture.host
        .open(fixture.ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      fixture.surface.mount();
      const [component] = fixture.surface.overlays;
      const options = fixture.surface.overlayOptions;
      for (const [columns, rows] of [
        [160, 50],
        [124, 50],
        [160, 29],
        [125, 30],
      ] as const) {
        Object.assign(fixture.surface.terminal, { columns, rows });
        const { width, height } = screenViewport({ columns, rows });
        const rendered = component?.render(width).length;
        expect([options?.width, options?.maxHeight, rendered]).toEqual([width, height, height]);
      }
      yield* Fiber.interrupt(open);
      expect(fixture.surface.overlays).toEqual([]);
    }),
  );
  it.effect("admits one manager and closes only its owned overlay beneath a questionnaire", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const open = yield* fixture.host
        .open(fixture.ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* fixture.host.open(fixture.ctx);
      fixture.surface.mount();
      fixture.surface.mount();
      expect(fixture.surface.overlays).toHaveLength(1);
      const questionnaire = { render: () => ["questionnaire"], invalidate() {} };
      fixture.surface.showUnrelated(questionnaire);
      fixture.host.deactivate();
      yield* Fiber.join(open);
      expect(fixture.surface.overlays).toEqual([questionnaire]);
      expect(fixture.surface.doneCalls).toBe(1);
    }),
  );
});
