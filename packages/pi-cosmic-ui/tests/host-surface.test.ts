import type { OverlayHandle } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  hasCustomSurface,
  openOwnedSurface,
  openOwnedSurfacePromise,
  type OwnedSurfaceComponent,
  type OwnedSurfaceHost,
  type OwnedSurfaceOptions,
} from "../src/boundary/host-surface.ts";
import {
  fakeCustomSurfaceHost,
  type FakeCustomSurfaceHost,
} from "../src/testing/custom-surface.ts";

const view = (text = "view"): OwnedSurfaceComponent => ({ render: () => [text], invalidate() {} });
const open = <A>(h: FakeCustomSurfaceHost, options: OwnedSurfaceOptions<A>) =>
  openOwnedSurface(h.ctx, options).pipe(Effect.forkScoped({ startImmediately: true }));
const capture = () => {
  let host: OwnedSurfaceHost<string> | undefined;
  return {
    create: (next: OwnedSurfaceHost<string>) => {
      host = next;
      return view();
    },
    finish: (value: string) => host?.finish(value),
  };
};

describe("owned custom surfaces", () => {
  it.effect("keeps screen bounds and allocated height live across resizes", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let height = () => 0;
      const fiber = yield* open(h, {
        placement: "screen",
        closedValue: undefined,
        create: (host) => {
          height = host.getHeight;
          return view();
        },
      });
      h.mount();
      const options = h.overlayOptions!;
      for (const [columns, rows, width, allocated] of [
        [160, 50, 144, 45],
        [124, 50, 124, 50],
        [160, 29, 160, 29],
        [125, 30, 112, 27],
      ]) {
        Object.assign(h.terminal, { columns, rows });
        expect([options.width, options.maxHeight, height()]).toEqual([width, allocated, allocated]);
      }
      yield* Fiber.interrupt(fiber);
      expect(h.overlays).toEqual([]);
      expect(h.doneCalls).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("closing a screen keeps a questionnaire dock stacked above it", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      const screen = capture();
      const events: string[] = [];
      const tasks = yield* open(h, {
        placement: "screen",
        closedValue: "closed",
        create: screen.create,
        onClose: () => events.push(`revoked after ${h.doneCalls} done calls`),
      });
      h.mount();
      const dock = yield* open(h, {
        placement: "dock",
        closedValue: "cancel",
        create: () => view(),
      });
      h.mount();
      const [dockInput] = h.overlays.slice(-1);
      screen.finish("selected");
      expect(yield* Fiber.join(tasks)).toBe("selected");
      expect(events).toEqual(["revoked after 0 done calls"]);
      expect(h.overlays).toEqual([dockInput]);
      expect(h.widgets.size).toBe(1);
      yield* Fiber.interrupt(dock);
      expect(h.overlays).toEqual([]);
      expect(h.widgets.size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("holds a finish requested before mount and skips onMounted", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let mounted = false;
      const fiber = yield* open(h, {
        placement: "screen",
        closedValue: "closed",
        create: (host) => {
          host.finish("early");
          host.finish("ignored");
          return view();
        },
        onMounted: () => {
          mounted = true;
        },
      });
      expect(h.doneCalls).toBe(0);
      h.mount();
      expect(yield* Fiber.join(fiber)).toBe("early");
      expect([mounted, h.doneCalls, h.overlays]).toEqual([false, 1, []]);
    }).pipe(Effect.scoped),
  );

  it.effect("interruption before mount revokes at once and closes on the late mount", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let revoked = 0;
      let mounted = false;
      const fiber = yield* open(h, {
        placement: "screen",
        closedValue: "closed",
        create: () => view(),
        onClose: () => {
          revoked += 1;
        },
        onMounted: () => {
          mounted = true;
        },
      });
      yield* Fiber.interrupt(fiber);
      expect([revoked, h.doneCalls]).toEqual([1, 0]);
      const unrelated = view("unrelated");
      h.showUnrelated(unrelated);
      h.mount();
      expect([revoked, h.doneCalls, mounted]).toEqual([1, 1, false]);
      expect(h.overlays).toEqual([unrelated]);
    }).pipe(Effect.scoped),
  );

  it.effect("gives a stale owner an inert component and its closed value", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let created = 0;
      const stale = yield* open(h, {
        placement: "screen",
        closedValue: "closed",
        isCurrent: () => false,
        create: () => {
          created += 1;
          return view();
        },
      });
      h.mount();
      expect(yield* Fiber.join(stale)).toBe("closed");
      expect(created).toBe(0);

      let current = true;
      const screen = capture();
      const replaced = yield* open(h, {
        placement: "screen",
        closedValue: "closed",
        isCurrent: () => current,
        create: screen.create,
      });
      h.mount();
      current = false;
      screen.finish("selected");
      expect(yield* Fiber.join(replaced)).toBe("closed");
      expect(h.overlays).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed on each guarded-close fault without an unguarded global pop", () =>
    Effect.gen(function* () {
      for (const [fault, doneCalls] of [
        ["ownedHide", 0],
        ["guardShow", 0],
        ["done", 0],
        ["guardHide", 1],
      ] as const) {
        const h = fakeCustomSurfaceHost();
        const screen = capture();
        const fiber = yield* open(h, {
          placement: "screen",
          closedValue: "closed",
          create: screen.create,
        });
        h.mount();
        const unrelated = view("unrelated");
        h.showUnrelated(unrelated);
        h.fail(fault);
        screen.finish("selected");
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({ reason: "failed" });
        expect(h.doneCalls).toBe(doneCalls);
        expect(h.overlays).toContain(unrelated);
        expect(h.overlays.at(-1)).toBe(unrelated);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("admits beside custom and releases after done and dock disposal", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      const released: Array<readonly [number, number]> = [];
      const dock = capture();
      const fiber = yield* open(h, {
        placement: "dock",
        closedValue: "cancel",
        admit: () => () => released.push([h.doneCalls, h.widgets.size]),
        create: dock.create,
      });
      expect(h.widgets.size).toBe(1);
      h.mount();
      dock.finish("submitted");
      expect(yield* Fiber.join(fiber)).toBe("submitted");
      expect(released).toEqual([[1, 0]]);

      let controlled = false;
      const blocked = yield* open(h, {
        placement: "dock",
        closedValue: "cancel",
        admit: () => false,
        create: () => view(),
        onControl: () => {
          controlled = true;
        },
      });
      expect(yield* Fiber.join(blocked).pipe(Effect.flip)).toMatchObject({ reason: "blocked" });
      expect([controlled, h.widgets.size]).toEqual([true, 0]);
      h.mount();
      expect(h.doneCalls).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("disposes the dock on a pre-mount abort and hands over the dock-wrapped handle", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      const aborted = yield* open(h, {
        placement: "dock",
        closedValue: "cancel",
        create: () => view(),
      });
      expect(h.widgets.size).toBe(1);
      yield* Fiber.interrupt(aborted);
      expect(h.widgets.size).toBe(0);
      h.mount();

      let handle: OverlayHandle | undefined;
      const fiber = yield* open(h, {
        placement: "dock",
        closedValue: "cancel",
        create: () => view(),
        onMounted: (mounted) => {
          handle = mounted;
        },
      });
      h.mount();
      const before = h.renders;
      handle?.setHidden(true);
      expect([h.overlays, h.renders]).toEqual([[], before + 1]);
      handle?.hide();
      expect(h.widgets.size).toBe(0);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("an external control closes a mounted surface with its closed value", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let close: (() => void) | undefined;
      const fiber = yield* open(h, {
        placement: "screen",
        closedValue: "closed",
        create: () => view(),
        onControl: (control) => {
          close = control;
        },
      });
      h.mount();
      close?.();
      close?.();
      expect(yield* Fiber.join(fiber)).toBe("closed");
      expect([h.doneCalls, h.overlays]).toEqual([1, []]);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes inline surfaces directly, even inside the factory, with no guard", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      const immediate = yield* open(h, {
        placement: "inline",
        closedValue: "closed",
        create: (host) => {
          host.finish("now");
          return view();
        },
      });
      expect(h.doneCalls).toBe(1);
      expect(yield* Fiber.join(immediate)).toBe("now");
      h.mount();
      expect(h.editor).toBeUndefined();

      const inline = capture();
      const mounted = yield* open(h, {
        placement: "inline",
        closedValue: "closed",
        create: inline.create,
      });
      h.mount();
      expect(h.editor).toBeDefined();
      inline.finish("saved");
      expect(yield* Fiber.join(mounted)).toBe("saved");
      expect([h.editor, h.overlays, h.doneCalls]).toEqual([undefined, [], 2]);

      // A throwing inline done is contained and leaves Pi's Promise in charge.
      const hostile = capture();
      const pending = yield* open(h, {
        placement: "inline",
        closedValue: "closed",
        create: hostile.create,
      });
      h.mount();
      h.fail("done");
      expect(() => hostile.finish("saved")).not.toThrow();
      expect([pending.pollUnsafe(), h.doneCalls]).toEqual([undefined, 2]);
      yield* Fiber.interrupt(pending);
    }).pipe(Effect.scoped),
  );

  it("passes plain options to the component-sized overlay placement", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      const panel = view("panel");
      const outcome = openOwnedSurfacePromise(h.ctx, {
        placement: "overlay",
        closedValue: undefined,
        create: (host) => ({ ...panel, handleInput: () => host.finish(undefined) }),
      });
      h.mount();
      expect(h.overlayOptions).toBeUndefined();
      expect(h.overlays).toHaveLength(1);
      h.overlays[0]?.handleInput?.("q");
      expect(yield* Effect.promise(() => outcome)).toEqual({ _tag: "Settled", value: undefined });
    }).pipe(Effect.runPromise));

  it("keeps a factory failure's cause for Promise callers and types it for Effect callers", () =>
    Effect.gen(function* () {
      const failure = new Error("factory failed");
      const options: OwnedSurfaceOptions<string> = {
        placement: "screen",
        closedValue: "closed",
        create: () => {
          throw failure;
        },
      };
      const h = fakeCustomSurfaceHost();
      expect(yield* Effect.promise(() => openOwnedSurfacePromise(h.ctx, options))).toEqual({
        _tag: "Failed",
        cause: failure,
      });
      expect(yield* openOwnedSurface(h.ctx, options).pipe(Effect.flip)).toMatchObject({
        _tag: "OwnedSurfaceError",
        reason: "failed",
      });
    }).pipe(Effect.runPromise));

  it("reports custom-surface support fail-closed", () => {
    expect(hasCustomSurface(fakeCustomSurfaceHost().ctx)).toBe(true);
    expect(hasCustomSurface({ ...fakeCustomSurfaceHost().ctx, mode: "rpc" })).toBe(false);
    const hostile = {
      mode: "tui" as const,
      get ui(): never {
        throw new Error("host unavailable");
      },
    };
    expect(hasCustomSurface(hostile)).toBe(false);
  });
});
