import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  openOwnedSurface,
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
const capture = (text = "view") => {
  let host: OwnedSurfaceHost<string> | undefined;
  const component = view(text);
  return {
    component,
    create: (next: OwnedSurfaceHost<string>) => {
      host = next;
      return component;
    },
    finish: (value: string) => host?.finish(value),
  };
};

describe("owned custom surfaces", () => {
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

  it.effect("inline surfaces stack and close only their own dialog", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      const first = capture("first");
      const second = capture("second");
      const lower = yield* open(h, {
        placement: "inline",
        closedValue: "closed",
        create: first.create,
      });
      h.mount();
      const upper = yield* open(h, {
        placement: "inline",
        closedValue: "closed",
        create: second.create,
      });
      h.mount();
      expect(h.editor).toBe(second.component);
      yield* Fiber.interrupt(lower);
      expect(h.editor).toBe(second.component);
      second.finish("selected");
      expect(yield* Fiber.join(upper)).toBe("selected");
      expect(h.editor).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("a failed close is reported and still completes the host opening", () =>
    Effect.gen(function* () {
      for (const [placement, fault, doneCalls] of [
        ["screen", "ownedHide", 1],
        ["dock", "dispose", 1],
        ["screen", "done", 0],
      ] as const) {
        const h = fakeCustomSurfaceHost();
        const events: string[] = [];
        let finish: (() => void) | undefined;
        const fiber = yield* open(h, {
          placement,
          closedValue: "closed",
          admit: () => () => events.push(`released after ${h.doneCalls} done calls`),
          create: (host) => {
            finish = () => host.finish("selected");
            return {
              ...view(),
              dispose: () => {
                if (fault === "dispose") throw new Error("Injected dispose failure");
              },
            };
          },
        });
        h.mount();
        const unrelated = view("unrelated");
        h.showUnrelated(unrelated);
        if (fault !== "dispose") h.fail(fault);
        finish?.();
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({ reason: "failed" });
        expect(events).toEqual([`released after ${doneCalls} done calls`]);
        expect([h.doneCalls, h.overlays, h.widgets.size]).toEqual([doneCalls, [unrelated], 0]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "releases a dock component's owned cleanup on completion and pre-mount interruption",
    () =>
      Effect.gen(function* () {
        for (const completed of [true, false]) {
          const h = fakeCustomSurfaceHost();
          const resources = new Set<object>();
          let releases = 0;
          let finish: (() => void) | undefined;
          const fiber = yield* open(h, {
            placement: "dock",
            closedValue: undefined,
            create: (host) => {
              const resource = {};
              resources.add(resource);
              finish = () => host.finish(undefined);
              return {
                ...view(),
                dispose: () => {
                  releases++;
                  if (!resources.delete(resource)) throw new Error("Resource released twice");
                },
              };
            },
          });
          expect(resources.size).toBe(1);
          if (completed) {
            h.mount();
            finish?.();
            yield* Fiber.join(fiber);
          } else yield* Fiber.interrupt(fiber);
          expect(resources.size).toBe(0);
          expect(h.widgets.size).toBe(0);
          h.mount();
          expect(h.overlays).toEqual([]);
          expect(releases).toBe(1);
        }
      }),
  );

  it.effect("releases a dock component returned after reentrant closure during creation", () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let close: (() => void) | undefined;
      let releases = 0;
      const fiber = yield* open(h, {
        placement: "dock",
        closedValue: undefined,
        onControl: (control) => {
          close = control;
        },
        create: () => {
          close?.();
          return {
            ...view(),
            dispose: () => {
              releases++;
            },
          };
        },
      });
      h.mount();
      yield* Fiber.join(fiber);
      expect(releases).toBe(1);
      expect(h.widgets.size).toBe(0);
      expect(h.overlays).toEqual([]);
    }),
  );
});
