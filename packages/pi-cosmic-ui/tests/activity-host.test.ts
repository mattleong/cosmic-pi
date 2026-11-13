import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { deferredPromise, yieldUntil } from "pi-cosmic-core/testing";
import { ACTIVITY_EVENT, ActivitySnapshotSchema, activityKey } from "../src/activity/protocol.ts";
import { activityHostHarness as harness, activityItem as item } from "./support/activity.ts";

describe("activity host lifecycle", () => {
  it.effect("does not open a retired manager after its implementation finishes loading", () =>
    Effect.gen(function* () {
      const loaded = deferredPromise<typeof import("../src/activity/component.ts")>();
      let loading = false;
      const fixture = harness({
        loadComponent: () => {
          loading = true;
          return loaded.promise;
        },
      });
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const opening = yield* fixture.host.open(fixture.ctx).pipe(Effect.forkScoped);
      yield* yieldUntil(() => loading);
      fixture.host.deactivate();
      loaded.resolve(yield* Effect.promise(() => import("../src/activity/component.ts")));
      yield* Fiber.join(opening);
      expect(fixture.surface.pendingMounts).toBe(0);
      expect(fixture.surface.overlays).toEqual([]);
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const next = yield* fixture.openManager();
      next.component.handleInput("q");
      yield* Fiber.join(next.open);
    }),
  );

  it.effect("releases failed manager loading so a subsequent invocation can open", () =>
    Effect.gen(function* () {
      let fail = true;
      const fixture = harness({
        loadComponent: () =>
          fail
            ? Promise.reject(new Error("module unavailable"))
            : import("../src/activity/component.ts"),
      });
      fixture.host.activate(fixture.ctx, yield* fixture.service());
      const failed = yield* fixture.host.open(fixture.ctx).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(fixture.surface.pendingMounts).toBe(0);
      fail = false;
      const next = yield* fixture.openManager();
      next.component.handleInput("q");
      yield* Fiber.join(next.open);
    }),
  );

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
      const fixture = harness({ widget: "deferred" });
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
      const fixture = harness({ widget: "throws-after-factory" });
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
      // Absent fields join as empty lines, matching the native join this replaced.
      const broadcast = Arr.join(
        Arr.flatMap(decoded, (event) =>
          Arr.flatMap(event.items, (activity) => [
            activity.title,
            activity.summary ?? "",
            activity.detail ?? "",
            ...Arr.flatMap(activity.actions ?? [], (action) => [
              action.label,
              action.confirmation ?? "",
            ]),
          ]),
        ),
        "\n",
      );
      expect(broadcast).not.toContain("private-value");
      expect(broadcast).not.toContain("hunter2");
      expect(broadcast).not.toContain("do-not-leak");
      provider.dispose();
    }),
  );
});
