import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { makeAskUserPromptGate } from "../../src/boundary/host-prompt.ts";
import type { AskUserOutcome } from "../../src/questionnaire/model.ts";

export const opaqueHostFixture = <A>(value: A): never => {
  // SAFETY: Fixtures supply the opaque Pi/TUI members exercised by the owning tests.
  return value as never;
};

interface PromiseGate<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A | PromiseLike<A>) => void;
}

export const controlled = <A = void>() =>
  // SAFETY: Supported Node versions provide withResolvers, omitted by the ES2023 lib.
  (
    Promise as PromiseConstructor & {
      withResolvers<Value>(): PromiseGate<Value>;
    }
  ).withResolvers<A>();

export const theme: Theme = opaqueHostFixture({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});

type Factory = (
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (outcome: AskUserOutcome) => void,
) => Component;

// Models the owned public UI boundary, including Pi 0.85's global-pop done bug.
// Factory execution and the onHandle mount acknowledgement stay separate.
export const makeTuiHost = (gate?: ReturnType<typeof makeAskUserPromptGate>) => {
  const stack: Component[] = [];
  const ownedHide = vi.fn();
  const guardHide = vi.fn();
  const createGuard = vi.fn();
  let mount: (() => void) | undefined;
  let component: Component | undefined;
  const showOverlay = (item: Component, hide?: () => void): OverlayHandle => {
    stack.push(item);
    return opaqueHostFixture({
      hide: () => {
        hide?.();
        const i = stack.indexOf(item);
        if (i >= 0) stack.splice(i, 1);
      },
      setHidden: vi.fn(),
      focus: vi.fn(),
    });
  };
  const tui = {
    requestRender: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    showOverlay: (item: Component) => {
      createGuard();
      return showOverlay(item, guardHide);
    },
  };
  const done = vi.fn<(outcome: AskUserOutcome) => void>();
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    custom: vi.fn((factory: Factory, options: { onHandle: (handle: OverlayHandle) => void }) => {
      gate?.started();
      const completed = controlled<AskUserOutcome>();
      component = factory(
        opaqueHostFixture(tui),
        theme,
        opaqueHostFixture({
          matches: (data: string, key: string) =>
            (data === "\r" && key === "tui.select.confirm") ||
            (data === "external" && key === "app.editor.external") ||
            (data === "\u001b" && key === "tui.select.cancel"),
        }),
        (outcome) => {
          done(outcome);
          stack.pop();
          completed.resolve(outcome);
        },
      );
      const owned = component;
      mount = () => options.onHandle(showOverlay(owned, ownedHide));
      return completed.promise.finally(() => gate?.ended());
    }),
  };
  const ctx: ExtensionContext = opaqueHostFixture({
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
    stack,
    showOverlay,
    done,
    ownedHide,
    guardHide,
    createGuard,
    get customCalls() {
      return ui.custom.mock.calls.length;
    },
    get mount() {
      return mount;
    },
    get component() {
      return component;
    },
  };
};
