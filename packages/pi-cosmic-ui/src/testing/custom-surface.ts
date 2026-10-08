import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import {
  deferredPromise,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";

/** One-shot faults: the owned handle's hide, guard creation, `done`, and the guard's hide. */
type CustomSurfaceFault = "ownedHide" | "guardShow" | "done" | "guardHide";

type Disposable = Component & { dispose?(): void };
type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];

const empty = (): Component => ({ render: () => [], invalidate() {} });

/**
 * Models Pi's custom UI host, unchanged from 0.86 through the pinned 1.0. The factory runs synchronously inside `custom`,
 * and a throw rejects its Promise. Mounting (`showOverlay` plus `onHandle`, or the editor
 * slot) waits for `mount()`. `done` pops the top overlay, not its own, then disposes the
 * mounted component. Non-capturing overlays are treated as close guards.
 */
export function fakeCustomSurfaceHost(
  options: {
    readonly columns?: number;
    readonly rows?: number;
    readonly keybindings?: KeybindingsManager;
    readonly theme?: Theme;
  } = {},
) {
  const stack: Array<{ readonly component: Component; hidden: boolean }> = [];
  const widgets = new Map<string, Component>();
  const faults = new Set<CustomSurfaceFault>();
  const mounts: Array<() => void> = [];
  const terminal = { columns: options.columns ?? 160, rows: options.rows ?? 50 };
  const theme = options.theme ?? plainTheme;
  const keybindings =
    options.keybindings ?? opaqueFixture({ matches: () => false, getKeys: () => [] });
  let editor: Component | undefined;
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
  const tui = {
    terminal,
    requestRender: () => {
      renders += 1;
    },
    showOverlay: (component: Component, overlay?: OverlayOptions) => {
      if (!overlay?.nonCapturing) return show(component);
      trip("guardShow");
      return show(component, "guardHide");
    },
  };

  const custom = <T>(
    factory: (
      tui: TUI,
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
    const reject = (cause: unknown) =>
      completion.reject(Predicate.isError(cause) ? cause : new Error(String(cause)));
    const done = (result: T) => {
      if (closed) return;
      trip("done");
      closed = true;
      doneCalls += 1;
      if (overlay) stack.pop();
      else editor = undefined;
      completion.resolve(result);
      try {
        mounted?.dispose?.();
      } catch {
        // Pi ignores dispose errors.
      }
    };
    try {
      const created = factory(opaqueFixture(tui), theme, keybindings, done);
      if (Predicate.isPromiseLike(created))
        throw new Error("The fake host models synchronous factories only.");
      mounts.push(() => {
        if (closed) return;
        mounted = created;
        try {
          if (!overlay) {
            editor = created;
            return;
          }
          const configured = customOptions?.overlayOptions;
          lastOverlayOptions = Predicate.isFunction(configured) ? configured() : configured;
          // Pi shows the overlay whether or not the caller asked for its handle.
          const handle = show(created, "ownedHide");
          customOptions?.onHandle?.(handle);
        } catch (cause) {
          // Pi's mount chain rejects the opening unless it already closed.
          if (closed) return;
          if (!overlay) editor = undefined;
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
      content: ((tui: TUI, theme: Theme) => Disposable) | readonly string[] | undefined,
    ) => {
      if (content === undefined) widgets.delete(key);
      else if (Predicate.isFunction(content)) widgets.set(key, content(opaqueFixture(tui), theme));
      else widgets.set(key, { render: () => [...content], invalidate() {} });
    },
  };

  return {
    ctx: extensionContextFixture({ mode: "tui" as const, hasUI: true, ui }),
    tui,
    terminal,
    /** Mounts the oldest pending opening, as Pi does one microtask after its factory. */
    mount: () => mounts.shift()?.(),
    /** Shows an unrelated overlay, such as a newer questionnaire, above the current stack. */
    showUnrelated: (component: Component = empty()) => show(component),
    fail: (fault: CustomSurfaceFault) => {
      faults.add(fault);
    },
    /** Visible overlay components, bottom to top. */
    get overlays() {
      return stack.filter((entry) => !entry.hidden).map((entry) => entry.component);
    },
    get widgets(): ReadonlyMap<string, Component> {
      return widgets;
    },
    get editor() {
      return editor;
    },
    get doneCalls() {
      return doneCalls;
    },
    get renders() {
      return renders;
    },
    /** The resolved overlay options of the latest mount. */
    get overlayOptions() {
      return lastOverlayOptions;
    },
  };
}

export type FakeCustomSurfaceHost = ReturnType<typeof fakeCustomSurfaceHost>;
