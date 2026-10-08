import { synchronousRandomUuid } from "pi-cosmic-core";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";

const INPUT_DOCK_PRESENCE = Symbol.for("@cosmic-pi/pi-cosmic-ui/input-dock-presence/v1");

interface InputDockPresence {
  [INPUT_DOCK_PRESENCE]?: Set<string>;
}

// Each extension loads its own copy of this module, so visible docks are shared per process.
const visibleDocks = (): Set<string> => {
  // SAFETY: this process-owned symbol slot is the sole property this module adds to globalThis.
  const state = globalThis as typeof globalThis & InputDockPresence;
  const current = state[INPUT_DOCK_PRESENCE];
  if (current instanceof Set) return current;
  const created = new Set<string>();
  state[INPUT_DOCK_PRESENCE] = created;
  return created;
};

/**
 * True while any extension shows an input dock above the editor. In fullscreen, above-editor
 * widgets share one shrinking slot, so other widgets compact to keep the dock fully visible.
 */
export const inputDockVisible = (): boolean => visibleDocks().size > 0;

/** The drawing widget and keyboard-only overlay of one owned-surface `dock` opening. */
export const createInputDock = (ui: ExtensionUIContext) => {
  const widgetKey = `cosmic-input-dock-${synchronousRandomUuid()}`;
  let tui: TUI | undefined;
  let dialog: (Component & Partial<Focusable>) | undefined;
  let mounted = false;
  let hidden = false;
  let disposed = false;

  const widget: Component = {
    render: (width) => (!disposed && !hidden ? (dialog?.render(width) ?? []) : []),
    invalidate: () => dialog?.invalidate(),
  };
  // The owned surface closes the keyboard overlay; the caller owns prompt lifecycle.
  // Only the above-editor widget draws the panel, never the overlay.
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
    if (dialog) dialog.focused = false;
    if (mounted) ui.setWidget(widgetKey, undefined);
  };

  return {
    input,
    // Leave room for Pi's editor, footer, and other widgets. Pi owns final dock allocation.
    getHeight: () => Math.max(1, Math.floor((tui?.terminal.rows ?? 0) * 0.6)),
    mount(host: TUI, component: Component & Partial<Focusable>): void {
      if (disposed) return;
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
