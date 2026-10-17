import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  extensionContextFixture,
  piKeybindingsFixture,
  plainTheme,
  tuiFixture,
  type HostTui,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { expect, vi } from "vitest";
import type { createAskUserPromptGate } from "../../src/boundary/host-prompt.ts";
import { createAskUserDialogBridge, type AskUserDialogBridge } from "../../src/boundary/host-ui.ts";

type SettleOpen = <Outcome>(completed: Promise<Outcome>) => Promise<Outcome>;
type Surface = Component & { dispose?(): void };
type CustomFactory<Outcome> = (
  tui: HostTui,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: Outcome) => void,
) => Surface | Promise<Surface>;
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];

const spyHide = (handle: OverlayHandle, spy: () => void): OverlayHandle => ({
  ...handle,
  hide: () => {
    spy();
    handle.hide();
  },
});

export const makeTuiHost = (gate?: ReturnType<typeof createAskUserPromptGate>) => {
  const host = fakeCustomSurfaceHost({
    columns: 200,
    rows: 60,
    theme: plainTheme,
    keybindings: piKeybindingsFixture({
      matches: (data, key) =>
        (data === "\r" && key === "tui.select.confirm") ||
        (data === "external" && key === "app.editor.external") ||
        (data === "\u001b" && key === "tui.select.cancel"),
    }),
  });
  const ownedHide = vi.fn();
  const guardHide = vi.fn();
  const createGuard = vi.fn();
  const done = vi.fn(<Outcome>(outcome: Outcome): Outcome => outcome);
  const requestRender = vi.fn();
  const stop = vi.fn();
  const start = vi.fn();
  let component: Component | undefined;
  let settleOpen: SettleOpen | undefined;
  const tui = tuiFixture({
    terminal: host.terminal,
    requestRender,
    stop,
    start,
    showOverlay: (item: Component, options?: OverlayOptions) => {
      createGuard();
      return spyHide(host.tui.showOverlay(item, options), guardHide);
    },
  });
  function custom<Outcome>(
    factory: CustomFactory<Outcome>,
    options?: CustomOptions,
  ): Promise<Outcome> {
    gate?.started();
    const completed = host.ctx.ui
      .custom<Outcome>(
        (_tui, hostTheme, keys, hostDone) => {
          const created = factory(tui, hostTheme, keys, (outcome) => {
            done(outcome);
            hostDone(outcome);
          });
          if (!Predicate.isPromiseLike(created)) component = created;
          return created;
        },
        {
          ...options,
          overlay: true,
          onHandle: (handle) => options?.onHandle?.(spyHide(handle, ownedHide)),
        },
      )
      .finally(() => gate?.ended());
    if (!settleOpen) return completed;
    host.mount();
    return settleOpen(completed);
  }
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: host.ctx.ui.setWidget.bind(host.ctx.ui),
    custom,
  };
  const customSpy = vi.spyOn(ui, "custom");
  const ctx = extensionContextFixture({
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui,
    isProjectTrusted: () => true,
  });
  return {
    ctx,
    ui,
    tui,
    tuiControls: { requestRender, stop, start },
    widgets: host.widgets,
    get stack() {
      return host.overlays;
    },
    showOverlay: (item: Component) => host.showUnrelated(item),
    settleOnOpen: (settle: SettleOpen) => {
      settleOpen = settle;
    },
    done,
    ownedHide,
    guardHide,
    createGuard,
    get customCalls() {
      return customSpy.mock.calls.length;
    },
    get mount() {
      return customSpy.mock.calls.length > 0 ? host.mount : undefined;
    },
    get component() {
      return component;
    },
  };
};

type TuiHost = ReturnType<typeof makeTuiHost>;

export const foreign: Component = { render: () => ["foreign"], invalidate: () => {} };

export const eventually = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion));

export const waitMounted = (h: TuiHost) => eventually(() => expect(h.mount).toBeDefined());

export const openPresentation = <A, E>(
  h: TuiHost,
  start: (bridge: AskUserDialogBridge) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bridge = createAskUserDialogBridge();
    const controller = new AbortController();
    const pending = Effect.runPromise(start(bridge), { signal: controller.signal });
    yield* waitMounted(h);
    return { bridge, controller, pending };
  });
