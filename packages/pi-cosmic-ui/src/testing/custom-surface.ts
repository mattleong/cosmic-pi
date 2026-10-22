import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import {
  deferredPromise,
  extensionContextFixture,
  piKeybindingsFixture,
  plainTheme,
  terminalFixture,
  tuiFixture,
  type HostTui,
} from "pi-cosmic-core/testing";

type CustomSurfaceFault = "ownedHide" | "done";

type Disposable = Component & { dispose?(): void };
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];

const empty = (): Component => ({ render: () => [], invalidate() {} });

export function fakeCustomSurfaceHost(
  options: {
    readonly columns?: number;
    readonly rows?: number;
    readonly keybindings?: KeybindingsManager;
    readonly theme?: Theme;
  } = {},
) {
  const stack: Array<{ readonly component: Component; hidden: boolean }> = [];
  // Inline openings share Pi's extension-dialog stack; the last entry is visible.
  const dialogs: Component[] = [];
  const widgets = new Map<string, Component>();
  const faults = new Set<CustomSurfaceFault>();
  const mounts: Array<() => void> = [];
  const size = { columns: options.columns ?? 160, rows: options.rows ?? 50 };
  const terminal = terminalFixture({
    get columns() {
      return size.columns;
    },
    get rows() {
      return size.rows;
    },
  });
  const theme = options.theme ?? plainTheme;
  const keybindings = options.keybindings ?? piKeybindingsFixture();
  let doneCalls = 0;
  let renders = 0;
  let lastOverlayOptions: OverlayOptions | undefined;

  const trip = (fault: CustomSurfaceFault) => {
    if (faults.delete(fault)) throw new Error(`Injected ${fault} failure`);
  };
  const show = (component: Component, fault?: CustomSurfaceFault): OverlayHandle => {
    const entry = { component, hidden: false };
    stack.push(entry);
    return {
      hide: () => {
        if (fault) trip(fault);
        const index = stack.indexOf(entry);
        if (index >= 0) stack.splice(index, 1);
      },
      setHidden: (hidden) => {
        entry.hidden = hidden;
      },
      isHidden: () => entry.hidden,
      focus: () => undefined,
      unfocus: () => undefined,
      isFocused: () => false,
      getBounds: () => undefined,
    };
  };
  const tui = tuiFixture({
    terminal,
    requestRender: () => {
      renders += 1;
    },
    showOverlay: (component) => show(component),
  });

  const custom = <T>(
    factory: (
      tui: HostTui,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => Disposable | Promise<Disposable>,
    customOptions?: CustomOptions,
  ): Promise<T> => {
    const completion = deferredPromise<T>();
    const overlay = customOptions?.overlay ?? false;
    let closed = false;
    let mounted: Disposable | undefined;
    let handle: OverlayHandle | undefined;
    const reject = (cause: unknown) =>
      completion.reject(Predicate.isError(cause) ? cause : new Error(String(cause)));
    const removeDialog = () => {
      const index = mounted ? dialogs.indexOf(mounted) : -1;
      if (index >= 0) dialogs.splice(index, 1);
    };
    // Like Pi, done removes only this opening's overlay or dialog, never the topmost one.
    const done = (result: T) => {
      if (closed) return;
      trip("done");
      closed = true;
      if (overlay) handle?.hide();
      else removeDialog();
      doneCalls += 1;
      completion.resolve(result);
      try {
        mounted?.dispose?.();
      } catch {}
    };
    try {
      const created = factory(tui, theme, keybindings, done);
      if (Predicate.isPromiseLike(created))
        throw new Error("The fake host models synchronous factories only.");
      mounts.push(() => {
        if (closed) return;
        mounted = created;
        try {
          if (!overlay) {
            dialogs.push(created);
            return;
          }
          const configured = customOptions?.overlayOptions;
          lastOverlayOptions = Predicate.isFunction(configured) ? configured() : configured;
          handle = show(created, "ownedHide");
          customOptions?.onHandle?.(handle);
        } catch (cause) {
          if (closed) return;
          if (!overlay) removeDialog();
          reject(cause);
        }
      });
    } catch (cause) {
      reject(cause);
    }
    return completion.promise;
  };

  const ui = {
    custom,
    setWidget: (
      key: string,
      content: ((tui: HostTui, theme: Theme) => Disposable) | readonly string[] | undefined,
    ) => {
      if (content === undefined) widgets.delete(key);
      else if (Predicate.isFunction(content)) widgets.set(key, content(tui, theme));
      else widgets.set(key, { render: () => [...content], invalidate() {} });
    },
  };

  return {
    ctx: extensionContextFixture({ mode: "tui" as const, hasUI: true, ui }),
    custom,
    tui,
    terminal,
    resize: (columns: number, rows: number) => {
      size.columns = columns;
      size.rows = rows;
    },
    mount: () => mounts.shift()?.(),
    showUnrelated: (component: Component = empty()) => show(component),
    fail: (fault: CustomSurfaceFault) => {
      faults.add(fault);
    },
    get overlays() {
      return stack.flatMap((entry) => (entry.hidden ? [] : [entry.component]));
    },
    get widgets(): ReadonlyMap<string, Component> {
      return widgets;
    },
    /** The visible inline dialog. */
    get editor(): Component | undefined {
      return dialogs.at(-1);
    },
    get doneCalls() {
      return doneCalls;
    },
    get renders() {
      return renders;
    },
    get overlayOptions() {
      return lastOverlayOptions;
    },
  };
}

export type FakeCustomSurfaceHost = ReturnType<typeof fakeCustomSurfaceHost>;
