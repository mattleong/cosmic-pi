import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import { discoverActivityView } from "../src/activity/view-protocol.ts";
import { activityHostHarness } from "./support/activity.ts";

const fixture = (mode: "tui" | "rpc" = "tui") =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context());
    const harness = activityHostHarness({
      mode,
      run: (effect, signal) => run(effect, signal ? { signal } : undefined),
    });
    harness.host.activate(harness.ctx, yield* harness.service());
    return harness;
  });

describe("activity view capability", () => {
  it.effect("is unavailable without an installed TUI host and is session-bound", () =>
    Effect.gen(function* () {
      const rpc = yield* fixture("rpc");
      expect(discoverActivityView(rpc.bus, "session")).toBeUndefined();
      const tui = yield* fixture();
      expect(discoverActivityView(tui.bus, "other")).toBeUndefined();
      expect(discoverActivityView(tui.bus, "session")).toBeDefined();
    }),
  );
  it.effect(
    "waits for manager closure, rejects busy admission, and preserves unrelated overlays",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const view = discoverActivityView(f.bus, "session")!;
        let settled = false;
        const opening = yield* Effect.tryPromise((signal) => view.open("tasks", signal)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* yieldUntil(() => f.surface.pendingMounts > 0);
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
          const view = discoverActivityView(f.bus, "session")!;
          const controller = new AbortController();
          controller.abort();
          yield* Effect.flip(Effect.tryPromise(() => view.open("tasks", controller.signal)));
          expect(f.surface.overlays).toEqual([]);
          return { view, f };
        }),
      );
      yield* Effect.flip(Effect.tryPromise(() => owned.view.open("tasks")));
      expect(discoverActivityView(owned.f.bus, "session")).toBeUndefined();
    }),
  );
});
