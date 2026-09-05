import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  ACTIVITY_EVENT,
  ActivitySnapshotSchema,
  registerActivityProvider,
  type ActivityEvents,
  type ActivityItem,
} from "../src/activity/protocol.ts";
import {
  ActivityService,
  type ActivityError,
  type ActivityServiceContract,
} from "../src/activity/service.ts";
import { makeActivityHost } from "../src/boundary/host-activity.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

const promiseGate = <A>() => {
  const deferred = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(deferred)),
    resolve: (value: A) => {
      Effect.runSync(Deferred.succeed(deferred, value));
    },
  };
};
type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type CustomOptions = Parameters<ExtensionContext["ui"]["custom"]>[1];
type Widget = Parameters<ExtensionContext["ui"]["setWidget"]>[1];
const tuiFixture = <Fixture extends object>(value: Fixture): Fixture & TUI => {
  // SAFETY: Tests invoke only the TUI operations supplied by each fixture.
  return value as Fixture & TUI;
};
const keybindingsFixture = <Fixture extends object>(
  value: Fixture,
): Fixture & Parameters<Factory>[2] => {
  // SAFETY: Tests invoke only matches/getKeys on their injected keybinding fixture.
  return value as Fixture & Parameters<Factory>[2];
};
const item = (id = "a"): ActivityItem => ({
  id,
  title: "Work",
  kind: "agent",
  status: "running",
  revision: "1",
});
function harness(mode: "normal" | "deferred" | "throws-after-factory" = "normal") {
  const handlers = new Map<string, Set<Parameters<ActivityEvents["on"]>[1]>>();
  const envelopes: Array<Parameters<ActivityEvents["emit"]>[1]> = [];
  const bus: ActivityEvents = {
    on(name, handler) {
      const listeners = handlers.get(name) ?? new Set();
      listeners.add(handler);
      handlers.set(name, listeners);
      return () => {
        listeners.delete(handler);
      };
    },
    emit(name, data) {
      if (name === ACTIVITY_EVENT) envelopes.push(data);
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
  };
  const work: Array<Effect.Effect<void, ActivityError>> = [];
  const host = makeActivityHost(extensionApiFixture({ events: bus }), (effect) => {
    work.push(effect);
  });
  const stack: OverlayHandle[] = [];
  let failGuard = false;
  let doneCount = 0;
  const makeHandle = () => {
    // SAFETY: These tests use only identity-based hide on overlay handles.
    const handle = {
      hide() {
        const index = stack.indexOf(handle);
        if (index >= 0) stack.splice(index, 1);
      },
    } as OverlayHandle;
    return handle;
  };
  // SAFETY: The host only reads these TUI methods and terminal rows in this suite.
  let redraws = 0;
  const tui = tuiFixture({
    terminal: { rows: 24 },
    requestRender() {
      redraws++;
    },
    showOverlay() {
      if (failGuard) throw new Error("guard unavailable");
      const handle = makeHandle();
      stack.push(handle);
      return handle;
    },
  });
  // SAFETY: Activity rendering uses only fg; other Theme methods are not exercised.
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  // SAFETY: Only matches/getKeys are used by the injected manager keymap.
  const keybindings = keybindingsFixture({ matches: () => false, getKeys: () => [] });
  let widget: Widget;
  let mountedWidget: (Component & { dispose?: () => void }) | undefined;
  const mountWidget = () => {
    if (!Predicate.isFunction(widget)) throw new Error("No widget factory");
    mountedWidget = widget(tui, theme);
  };
  const requests: Array<{
    readonly factory: Factory;
    readonly options: CustomOptions;
    readonly result: ReturnType<typeof promiseGate<unknown>>;
  }> = [];
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
      custom(factory: Factory, options: CustomOptions) {
        const result = promiseGate<unknown>();
        requests.push({ factory, options, result });
        return result.promise;
      },
      notify() {},
    },
  });
  const mount = (index: number) => {
    const request = requests[index]!;
    const component = request.factory(tui, theme, keybindings, (result) => {
      doneCount++;
      stack.pop();
      request.result.resolve(result);
    });
    const handle = makeHandle();
    stack.push(handle);
    request.options?.onHandle?.(handle);
    return component;
  };
  const foreignOverlay = () => {
    const handle = makeHandle();
    stack.push(handle);
    return handle;
  };
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
    host,
    ctx,
    stack,
    requests,
    envelopes,
    service,
    drain,
    mount,
    mountWidget,
    renderWidget: () => mountedWidget?.render(80) ?? [],
    redraws: () => redraws,
    foreignOverlay,
    pendingWork: () => work.length,
    disposeWidget: () => mountedWidget?.dispose?.(),
    failGuard: () => {
      failGuard = true;
    },
    doneCount: () => doneCount,
  };
}

describe("activity host lifecycle", () => {
  it.effect("renders launch metadata without rows and withdraws it on invalidation or revoke", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const service = yield* fixture.service();
      let starting = 2;
      const provider = registerActivityProvider(fixture.bus, {
        sessionId: "session",
        providerId: "agents",
        snapshot: () => [],
        starting: () => starting,
        invoke: () => Promise.resolve(),
      });
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
      fixture.host.tick(service, 100);
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
      fixture.host.tick(service, 100);
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
      const provider = registerActivityProvider(fixture.bus, {
        sessionId: "session",
        providerId: "agents",
        snapshot: () => [item()],
        invoke: () => Promise.resolve(),
      });
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
        const provider = registerActivityProvider(fixture.bus, {
          sessionId: "session",
          providerId: "agents",
          snapshot: () => items,
          invoke: () => Promise.resolve(),
        });
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
      const provider = registerActivityProvider(fixture.bus, {
        sessionId: "session",
        providerId: "agents",
        snapshot: () => [item()],
        invoke: () => Promise.resolve(),
      });
      fixture.host.activate(fixture.ctx, first);
      yield* fixture.drain();
      const captured = fixture.envelopes[0];
      provider.dispose();
      yield* fixture.drain();
      const replacement = yield* fixture.service();
      fixture.host.activate(fixture.ctx, replacement);
      fixture.bus.emit(ACTIVITY_EVENT, captured);
      yield* fixture.drain();
      expect(yield* replacement.snapshot).toEqual([]);
      const fresh = registerActivityProvider(fixture.bus, {
        sessionId: "session",
        providerId: "agents",
        snapshot: () => [item("fresh")],
        invoke: () => Promise.resolve(),
      });
      yield* fixture.drain();
      expect(fresh.isAvailable()).toBe(true);
      expect((yield* replacement.snapshot)[0]?.id).toBe("fresh");
      fresh.dispose();
    }),
  );
  it.effect("re-handshakes a live provider without accepting the old host envelope", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const provider = registerActivityProvider(fixture.bus, {
        sessionId: "session",
        providerId: "agents",
        snapshot: () => [item()],
        invoke: () => Promise.resolve(),
      });
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      yield* fixture.drain();
      const captured = fixture.envelopes[0];
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
      const provider = registerActivityProvider(fixture.bus, {
        sessionId: "session",
        providerId: "agents",
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
        invoke: () => Promise.resolve(),
      });
      yield* fixture.drain();
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ items: ActivitySnapshotSchema })),
      )(fixture.envelopes);
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
  it.effect("admits one manager and closes only its owned overlay beneath a questionnaire", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const open = yield* fixture.host.open(fixture.ctx).pipe(Effect.forkScoped);
      yield* yieldUntil(() => fixture.requests.length === 1);
      yield* fixture.host.open(fixture.ctx);
      expect(fixture.requests).toHaveLength(1);
      fixture.mount(0);
      const questionnaire = fixture.foreignOverlay();
      fixture.host.deactivate();
      yield* Fiber.join(open);
      expect(fixture.stack).toEqual([questionnaire]);
      expect(fixture.doneCount()).toBe(1);
    }),
  );
  it.effect("late mounting after cancellation cannot close a successor or questionnaire", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const first = yield* fixture.host.open(fixture.ctx).pipe(Effect.forkScoped);
      yield* yieldUntil(() => fixture.requests.length === 1);
      yield* Fiber.interrupt(first);
      const second = yield* fixture.host.open(fixture.ctx).pipe(Effect.forkScoped);
      yield* yieldUntil(() => fixture.requests.length === 2);
      fixture.mount(1);
      const questionnaire = fixture.foreignOverlay();
      fixture.mount(0);
      expect(fixture.stack).toHaveLength(2);
      expect(fixture.stack[1]).toBe(questionnaire);
      fixture.host.deactivate();
      yield* Fiber.join(second);
      expect(fixture.stack).toEqual([questionnaire]);
      expect(fixture.doneCount()).toBe(2);
    }),
  );
  it.effect("settles cleanup failure without an unguarded pop of another overlay", () =>
    Effect.gen(function* () {
      const fixture = harness();
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const open = yield* fixture.host.open(fixture.ctx).pipe(Effect.exit, Effect.forkScoped);
      yield* yieldUntil(() => fixture.requests.length === 1);
      fixture.mount(0);
      const questionnaire = fixture.foreignOverlay();
      fixture.failGuard();
      fixture.host.deactivate();
      const result = yield* Fiber.join(open);
      expect(result._tag).toBe("Failure");
      expect(fixture.stack).toEqual([questionnaire]);
      expect(fixture.doneCount()).toBe(0);
      fixture.requests[0]!.result.resolve(undefined);
    }),
  );
});
