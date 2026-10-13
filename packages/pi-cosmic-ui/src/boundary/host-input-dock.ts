import { synchronousRandomUuid } from "pi-cosmic-core";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";

const INPUT_DOCK_PRESENCE = Symbol.for("@cosmic-pi/pi-cosmic-ui/input-dock-presence/v1");

type InputDockComponent = Component & Partial<Focusable> & { dispose?(): void };

const visibleDocks = (): Set<unknown> => {
  const state: object = globalThis;
  const current = INPUT_DOCK_PRESENCE in state ? state[INPUT_DOCK_PRESENCE] : undefined;
  if (current instanceof Set) return current;
  const created = new Set<unknown>();
  Object.defineProperty(state, INPUT_DOCK_PRESENCE, {
    value: created,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return created;
};

export const inputDockVisible = (): boolean => visibleDocks().size > 0;

export const createInputDock = (ui: ExtensionUIContext) => {
  const widgetKey = `cosmic-input-dock-${synchronousRandomUuid()}`;
  let tui: TUI | undefined;
  let dialog: InputDockComponent | undefined;
  let mounted = false;
  let hidden = false;
  let disposed = false;

  const widget: Component = {
    render: (width) => (!disposed && !hidden ? (dialog?.render(width) ?? []) : []),
    invalidate: () => dialog?.invalidate(),
  };
  const input: Component & Focusable = {
    get focused() {
      return dialog?.focused ?? false;
    },
    set focused(value) {
      if (dialog) dialog.focused = value;
    },
    render: () => [],
    invalidate: () => dialog?.invalidate(),
    handleInput: (data) => {
      if (!disposed && !hidden) dialog?.handleInput?.(data);
    },
  };

  const syncPresence = (): void => {
    if (mounted && !disposed && !hidden) visibleDocks().add(widgetKey);
    else visibleDocks().delete(widgetKey);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    syncPresence();
    const component = dialog;
    dialog = undefined;
    try {
      if (component) component.focused = false;
    } finally {
      try {
        if (mounted) ui.setWidget(widgetKey, undefined);
      } finally {
        component?.dispose?.();
      }
    }
  };

  return {
    input,
    getHeight: () => Math.max(1, Math.floor((tui?.terminal.rows ?? 0) * 0.6)),
    mount(host: TUI, component: InputDockComponent): void {
      if (disposed) {
        component.dispose?.();
        return;
      }
      tui = host;
      dialog = component;
      mounted = true;
      syncPresence();
      ui.setWidget(widgetKey, () => widget, { placement: "aboveEditor" });
    },
    handle(handle: OverlayHandle): OverlayHandle {
      return {
        hide: () => {
          try {
            handle.hide();
          } finally {
            dispose();
          }
        },
        setHidden: (value) => {
          if (disposed) return;
          const changed = hidden !== value;
          hidden = value;
          syncPresence();
          handle.setHidden(value);
          if (changed) tui?.requestRender(true);
        },
        isHidden: () => handle.isHidden(),
        focus: () => handle.focus(),
        unfocus: (options) => handle.unfocus(options),
        isFocused: () => handle.isFocused(),
        getBounds: () => handle.getBounds(),
      };
    },
    dispose,
  };
};
