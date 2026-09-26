import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { openMcpOverlay, type McpOverlayHost } from "../../src/boundary/host-ui.ts";

const unrelatedView = () => ({ render: () => ["unrelated"], invalidate() {} });
const counted = () => {
  let host: McpOverlayHost<string> | undefined;
  const state = { disposed: 0 };
  return {
    state,
    finish: (value: string | undefined) => host?.finish(value),
    factory: (next: McpOverlayHost<string>) => {
      host = next;
      return {
        render: () => ["mcp"],
        invalidate() {},
        dispose: () => {
          state.disposed += 1;
        },
      };
    },
  };
};

it.effect(
  "resizing keeps retained overlay bounds and allocated height in sync without losing focus",
  () =>
    Effect.gen(function* () {
      const h = fakeCustomSurfaceHost();
      let height = () => 0;
      const opened = yield* Effect.forkScoped(
        openMcpOverlay(
          h.ctx,
          () => true,
          (host) => {
            height = host.getHeight;
            return { focused: false, render: () => [], invalidate() {} };
          },
        ),
        { startImmediately: true },
      );
      h.mount();
      const options = h.overlayOptions!;
      const view = h.overlays[0]!;
      Object.assign(view, { focused: true });
      for (const [columns, rows, width, allocated] of [
        [160, 50, 144, 45],
        [124, 50, 124, 50],
        [160, 29, 160, 29],
        [125, 30, 112, 27],
      ]) {
        Object.assign(h.terminal, { columns, rows });
        expect([options.width, options.maxHeight, height()]).toEqual([width, allocated, allocated]);
        expect(view).toMatchObject({ focused: true });
      }
      yield* Fiber.interrupt(opened);
      expect(h.overlays).toEqual([]);
    }),
);

it.effect("finishing removes only MCP, disposes once, and preserves a newer overlay", () =>
  Effect.gen(function* () {
    const h = fakeCustomSurfaceHost();
    const view = counted();
    const opened = yield* Effect.forkScoped(
      openMcpOverlay(h.ctx, () => true, view.factory),
      {
        startImmediately: true,
      },
    );
    h.mount();
    const unrelated = unrelatedView();
    h.showUnrelated(unrelated);
    view.finish("selected");
    expect(yield* Fiber.join(opened)).toBe("selected");
    expect(h.overlays).toEqual([unrelated]);
    expect([view.state.disposed, h.doneCalls]).toEqual([1, 1]);
  }),
);

it.effect("cancellation between factory and handle disposes once", () =>
  Effect.gen(function* () {
    const h = fakeCustomSurfaceHost();
    const view = counted();
    const opened = yield* Effect.forkScoped(
      openMcpOverlay(h.ctx, () => true, view.factory),
      {
        startImmediately: true,
      },
    );
    yield* Fiber.interrupt(opened);
    expect(view.state.disposed).toBe(1);
    const unrelated = unrelatedView();
    h.showUnrelated(unrelated);
    h.mount();
    expect(h.overlays).toEqual([unrelated]);
    expect([view.state.disposed, h.doneCalls]).toEqual([1, 1]);
  }),
);

it.effect("a failed guarded close reports that the MCP view could not close safely", () =>
  Effect.gen(function* () {
    const h = fakeCustomSurfaceHost();
    const view = counted();
    const opened = yield* Effect.forkScoped(
      openMcpOverlay(h.ctx, () => true, view.factory).pipe(Effect.flip),
      { startImmediately: true },
    );
    h.mount();
    h.fail("guardShow");
    view.finish(undefined);
    expect(yield* Fiber.join(opened)).toMatchObject({ kind: "unavailable" });
    expect(h.doneCalls).toBe(0);
  }),
);
