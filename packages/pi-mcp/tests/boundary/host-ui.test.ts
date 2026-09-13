import { expect, it } from "@effect/vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  Focusable,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import { openMcpOverlay } from "../../src/boundary/host-ui.ts";

interface OverlayOwner {
  readonly kind?: "overlay";
}
const asTui = <Fixture extends object>(fixture: Fixture): Fixture & TUI => {
  // SAFETY: Tests invoke only the TUI methods and terminal dimensions supplied by the fixture.
  return fixture as Fixture & TUI;
};
const harness = () => {
  const stack: OverlayOwner[] = [];
  const terminal = { columns: 160, rows: 50 };
  let overlayOptions: OverlayOptions | undefined;
  let invokeFactory: (() => void) | undefined;
  let mount: (() => void) | undefined;
  let doneCalls = 0;
  let guardFailure = false;
  let rendered: (Component & Partial<Focusable> & { dispose?: () => void }) | undefined;
  const handle = (identity: OverlayOwner): OverlayHandle => ({
    hide: () => {
      const index = stack.indexOf(identity);
      if (index >= 0) stack.splice(index, 1);
    },
    focus() {},
    unfocus() {},
    setHidden() {},
    isHidden: () => false,
    isFocused: () => false,
    getBounds: () => undefined,
  });
  const tuiFixture = {
    terminal,
    requestRender() {},
    showOverlay: () => {
      if (guardFailure) throw new Error("host guard failure");
      const identity = {};
      stack.push(identity);
      return handle(identity);
    },
  };
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
    Effect.runPromise(
      Effect.callback<Parameters<Parameters<typeof factory>[3]>[0]>((resume) => {
        overlayOptions = Predicate.isFunction(options?.overlayOptions)
          ? options.overlayOptions()
          : options?.overlayOptions;
        invokeFactory = () => {
          // SAFETY: Controlled synchronous factories use only the supplied TUI methods and never inspect theme/keybindings.
          rendered = factory(
            asTui(tuiFixture),
            {} as Parameters<typeof factory>[1],
            {} as Parameters<typeof factory>[2],
            (value) => {
              doneCalls += 1;
              stack.pop();
              resume(Effect.succeed(value));
            },
          ) as Component;
          mount = () => {
            const identity = {};
            stack.push(identity);
            options?.onHandle?.(handle(identity));
          };
        };
      }),
    );
  const fixture: Pick<ExtensionContext, "mode"> & {
    readonly ui: Pick<ExtensionContext["ui"], "custom">;
  } = { mode: "tui", ui: { custom } };
  // SAFETY: openMcpOverlay reads only mode and ui.custom from this controlled context.
  return {
    ctx: fixture as ExtensionContext,
    stack,
    terminal,
    options: () => overlayOptions,
    factory: () => invokeFactory?.(),
    mount: () => mount?.(),
    ready: () => invokeFactory !== undefined,
    failGuard: () => {
      guardFailure = true;
    },
    doneCalls: () => doneCalls,
    rendered: () => rendered,
  };
};
const ready = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let index = 0; index < 100 && !predicate(); index += 1) yield* Effect.yieldNow;
    expect(predicate()).toBe(true);
  });

it.effect(
  "resizing keeps retained overlay bounds and allocated height in sync without losing focus",
  () =>
    Effect.gen(function* () {
      const h = harness();
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
      );
      yield* ready(h.ready);
      h.factory();
      h.mount();
      const options = h.options()!;
      const view = h.rendered()!;
      view.focused = true;
      for (const [columns, rows, width, allocated] of [
        [160, 50, 144, 45],
        [124, 50, 124, 50],
        [160, 29, 160, 29],
        [125, 30, 112, 27],
      ]) {
        Object.assign(h.terminal, { columns, rows });
        expect(options.width).toBe(width);
        expect(options.maxHeight).toBe(allocated);
        expect(height()).toBe(allocated);
        expect(view.focused).toBe(true);
      }
      yield* Fiber.interrupt(opened);
      expect(h.stack).toEqual([]);
    }),
);

it.effect("finishing removes only MCP and preserves a newer unrelated overlay", () =>
  Effect.gen(function* () {
    const h = harness();
    let finish: (() => void) | undefined;
    let disposed = 0;
    const opened = yield* Effect.forkScoped(
      openMcpOverlay(
        h.ctx,
        () => true,
        (host) => {
          finish = () => host.finish("selected");
          return {
            render: () => [],
            invalidate() {},
            dispose: () => {
              disposed += 1;
            },
          };
        },
      ),
    );
    yield* ready(h.ready);
    h.factory();
    h.mount();
    const unrelated = {};
    h.stack.push(unrelated);
    h.rendered()?.dispose?.();
    finish?.();
    expect(yield* Fiber.join(opened)).toBe("selected");
    expect(h.stack).toEqual([unrelated]);
    expect(disposed).toBe(1);
    expect(h.doneCalls()).toBe(1);
    h.mount();
    expect(h.stack).toEqual([unrelated]);
    expect(h.doneCalls()).toBe(1);
  }),
);

it.effect("pre-factory cancellation remains safe when factory and mount arrive late", () =>
  Effect.gen(function* () {
    const h = harness();
    let created = 0;
    const opened = yield* Effect.forkScoped(
      openMcpOverlay(
        h.ctx,
        () => true,
        () => {
          created += 1;
          return { render: () => [], invalidate() {} };
        },
      ),
    );
    yield* ready(h.ready);
    yield* Fiber.interrupt(opened);
    const unrelated = {};
    h.stack.push(unrelated);
    h.factory();
    expect(h.doneCalls()).toBe(0);
    h.mount();
    expect(created).toBe(0);
    expect(h.rendered()?.render(80)).toEqual([]);
    expect(h.stack).toEqual([unrelated]);
    expect(h.doneCalls()).toBe(1);
  }),
);

it.effect("cancellation between factory and handle revokes callbacks and disposes once", () =>
  Effect.gen(function* () {
    const h = harness();
    let signal: AbortSignal | undefined;
    let disposed = 0;
    const opened = yield* Effect.forkScoped(
      openMcpOverlay(
        h.ctx,
        () => true,
        (host) => {
          signal = host.signal;
          return {
            render: () => [],
            invalidate() {},
            dispose: () => {
              disposed += 1;
            },
          };
        },
      ),
    );
    yield* ready(h.ready);
    h.factory();
    yield* Fiber.interrupt(opened);
    expect(signal?.aborted).toBe(true);
    expect(disposed).toBe(1);
    const unrelated = {};
    h.stack.push(unrelated);
    h.mount();
    expect(h.stack).toEqual([unrelated]);
    expect(disposed).toBe(1);
  }),
);

it.effect("a guard failure never calls Pi's unguarded global-pop completion", () =>
  Effect.gen(function* () {
    const h = harness();
    const done = yield* Deferred.make<() => void>();
    const opened = yield* Effect.forkScoped(
      Effect.result(
        openMcpOverlay(
          h.ctx,
          () => true,
          (host) => {
            Deferred.doneUnsafe(
              done,
              Effect.succeed(() => host.finish()),
            );
            return { render: () => [], invalidate() {} };
          },
        ),
      ),
    );
    yield* ready(h.ready);
    h.factory();
    h.mount();
    h.failGuard();
    const unrelated = {};
    h.stack.push(unrelated);
    (yield* Deferred.await(done))();
    expect(yield* Fiber.join(opened)).toMatchObject({
      _tag: "Failure",
      failure: { kind: "unavailable" },
    });
    expect(h.doneCalls()).toBe(0);
    expect(h.stack).toEqual([unrelated]);
  }),
);
