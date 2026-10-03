import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { ActivityService, type ActivityServiceContract } from "../src/activity/service.ts";
import { discoverActivityView } from "../src/activity/view-protocol.ts";
import { makeActivityHost } from "../src/boundary/host-activity.ts";
import { fakeCustomSurfaceHost } from "../src/testing/custom-surface.ts";
import { eventBus } from "./support/host.ts";

const fixture = (mode: "tui" | "rpc" = "tui") =>
  Effect.gen(function* () {
    const { events } = eventBus();
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const surface = fakeCustomSurfaceHost({
      columns: 80,
      rows: 24,
      theme: plainTheme,
      keybindings: opaqueFixture({ matches: () => false, getKeys: () => [] }),
    });
    const host = makeActivityHost(
      extensionApiFixture({ events }),
      () => undefined,
      (effect, signal) => run(effect, signal ? { signal } : undefined),
    );
    let dispose: (() => void) | undefined;
    const opened = deferredPromise<void>();
    const custom: ExtensionContext["ui"]["custom"] = (factory, options) => {
      const result = surface.ctx.ui.custom(factory, options);
      opened.resolve();
      return result;
    };
    const ctx = extensionContextFixture({
      mode,
      sessionManager: { getSessionId: () => "session" },
      ui: {
        custom,
        notify() {},
        setWidget(_key: string, value: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
          if (!value) {
            dispose?.();
            return;
          }
          if (Predicate.isFunction(value)) {
            const component = value(opaqueFixture({ requestRender() {} }), plainTheme);
            dispose = () => component.dispose?.();
          }
        },
      },
    });
    let connected: ActivityServiceContract | undefined;
    const service = yield* ActivityService.make({
      publish: (rows, starting) => {
        if (connected) host.publish(connected, rows, starting);
      },
      connect: (value) => {
        connected = value;
        return host.bind(value);
      },
    });
    host.activate(ctx, service);
    return { events, surface, host, opened };
  });

describe("activity view capability", () => {
  it.effect("is unavailable without an installed TUI host and is session-bound", () =>
    Effect.gen(function* () {
      const rpc = yield* fixture("rpc");
      expect(discoverActivityView(rpc.events, "session")).toBeUndefined();
      const tui = yield* fixture();
      expect(discoverActivityView(tui.events, "other")).toBeUndefined();
      expect(discoverActivityView(tui.events, "session")).toBeDefined();
    }),
  );
  it.effect(
    "waits for manager closure, rejects busy admission, and preserves unrelated overlays",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const view = discoverActivityView(f.events, "session")!;
        let settled = false;
        const opening = yield* Effect.tryPromise((signal) => view.open("tasks", signal)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.promise(() => f.opened.promise);
        f.surface.mount();
        expect(settled).toBe(false);
        yield* Effect.flip(Effect.tryPromise(() => view.open("subagents")));
        expect(f.surface.overlays).toHaveLength(1);
        const unrelated = { render: () => [], invalidate() {} };
        f.surface.showUnrelated(unrelated);
        f.host.deactivate();
        expect(yield* Fiber.join(opening)).toBe(true);
        expect(f.surface.overlays).toEqual([unrelated]);
      }),
  );
  it.effect("rejects cancellation without opening and revokes retained capabilities", () =>
    Effect.gen(function* () {
      const owned = yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const view = discoverActivityView(f.events, "session")!;
          const controller = new AbortController();
          controller.abort();
          yield* Effect.flip(Effect.tryPromise(() => view.open("tasks", controller.signal)));
          expect(f.surface.overlays).toEqual([]);
          return { view, f };
        }),
      );
      yield* Effect.flip(Effect.tryPromise(() => owned.view.open("tasks")));
      expect(discoverActivityView(owned.f.events, "session")).toBeUndefined();
    }),
  );
  it.effect("revokes the capability when the host deactivates", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const view = discoverActivityView(f.events, "session")!;
      f.host.deactivate();
      yield* Effect.flip(Effect.tryPromise(() => view.open("subagents")));
      expect(discoverActivityView(f.events, "session")).toBeUndefined();
      expect(f.surface.overlays).toEqual([]);
    }),
  );
});
