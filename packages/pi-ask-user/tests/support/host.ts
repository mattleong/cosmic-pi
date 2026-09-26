import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { expect, vi } from "vitest";
import type { makeAskUserPromptGate } from "../../src/boundary/host-prompt.ts";
import { makeAskUserDialogBridge, type AskUserDialogBridge } from "../../src/boundary/host-ui.ts";
import type { QuestionnaireEvents } from "../../src/protocol.ts";
import type { AskUserOutcome } from "../../src/questionnaire/model.ts";

type Factory = (
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (outcome: AskUserOutcome) => void,
) => Component;
type CustomOptions = { onHandle: (handle: OverlayHandle) => void; overlayOptions: OverlayOptions };

/** Keeps this package's spy surface over the shared pinned-Pi fake, whose `done` pops the
 * global overlay stack. Factory execution and the onHandle mount stay separate. */
export const makeTuiHost = (gate?: ReturnType<typeof makeAskUserPromptGate>) => {
  const host = fakeCustomSurfaceHost({
    columns: 200,
    rows: 60,
    theme: plainTheme,
    keybindings: opaqueFixture({
      matches: (data: string, key: string) =>
        (data === "\r" && key === "tui.select.confirm") ||
        (data === "external" && key === "app.editor.external") ||
        (data === "\u001b" && key === "tui.select.cancel"),
    }),
  });
  const ownedHide = vi.fn();
  const guardHide = vi.fn();
  const createGuard = vi.fn();
  const done = vi.fn<(outcome: AskUserOutcome) => void>();
  let component: Component | undefined;
  const spyHide = (handle: OverlayHandle, spy: () => void): OverlayHandle => ({
    ...handle,
    hide: () => {
      spy();
      handle.hide();
    },
  });
  const tui = {
    terminal: host.terminal,
    requestRender: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    showOverlay: (item: Component, options?: OverlayOptions) => {
      createGuard();
      return spyHide(host.tui.showOverlay(item, options), guardHide);
    },
  };
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(host.ctx.ui.setWidget),
    custom: vi.fn((factory: Factory, options: CustomOptions) => {
      gate?.started();
      return host.ctx.ui
        .custom<AskUserOutcome>(
          (_tui, hostTheme, keys, hostDone) =>
            (component = factory(opaqueFixture(tui), hostTheme, keys, (outcome) => {
              done(outcome);
              hostDone(outcome);
            })),
          {
            ...options,
            overlay: true,
            onHandle: (handle) => options.onHandle(spyHide(handle, ownedHide)),
          },
        )
        .finally(() => gate?.ended());
    }),
  };
  const ctx: ExtensionContext = opaqueFixture({
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
    widgets: host.widgets,
    /** Visible overlays, bottom to top. */
    get stack() {
      return host.overlays;
    },
    showOverlay: (item: Component) => host.showUnrelated(item),
    done,
    ownedHide,
    guardHide,
    createGuard,
    get customCalls() {
      return ui.custom.mock.calls.length;
    },
    /** Mounts the oldest pending opening, once any custom call has run. */
    get mount() {
      return ui.custom.mock.calls.length > 0 ? host.mount : undefined;
    },
    get component() {
      return component;
    },
  };
};

type TuiHost = ReturnType<typeof makeTuiHost>;

/** Waits for the custom factory; the test still decides when onHandle mounts it. */
export const waitMounted = (h: TuiHost) =>
  Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));

/** Starts an abortable presentation on a fresh dialog bridge and waits for its factory. */
export const openPresentation = <A, E>(
  h: TuiHost,
  start: (bridge: AskUserDialogBridge) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bridge = makeAskUserDialogBridge();
    const controller = new AbortController();
    const pending = Effect.runPromise(start(bridge), { signal: controller.signal });
    yield* waitMounted(h);
    return { bridge, controller, pending };
  });

/** Models Pi's multi-listener extension event bus. */
export const makeEventBus = (): QuestionnaireEvents => {
  const callbacks = new Map<string, Set<Parameters<QuestionnaireEvents["on"]>[1]>>();
  return {
    on: (name, listener) => {
      const listeners = callbacks.get(name) ?? new Set();
      listeners.add(listener);
      callbacks.set(name, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (name, data) => {
      for (const callback of callbacks.get(name) ?? []) callback(data);
    },
  };
};
