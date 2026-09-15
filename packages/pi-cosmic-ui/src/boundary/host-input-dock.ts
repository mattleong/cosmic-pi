import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle, TUI } from "@earendil-works/pi-tui";

/** The presenter owns both the drawing widget and the keyboard-only overlay. */
export const createInputDock = (ui: ExtensionUIContext) => {
  const widgetKey = `cosmic-input-dock-${randomUUID()}`;
  let tui: TUI | undefined;
  let dialog: (Component & Partial<Focusable>) | undefined;
  let mounted = false;
  let hidden = false;
  let disposed = false;

  const widget: Component = {
    render: (width) => (!disposed && !hidden ? (dialog?.render(width) ?? []) : []),
    invalidate: () => dialog?.invalidate(),
  };
  // custom() still owns prompt lifecycle, keyboard focus, and overlay cleanup.
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
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
          handle.setHidden(value);
          if (changed) tui?.requestRender(true);
        },
        isHidden: () => handle.isHidden(),
        focus: () => handle.focus(),
        unfocus: (options) => {
          if (options) handle.unfocus(options);
          else handle.unfocus();
        },
        isFocused: () => handle.isFocused(),
        getBounds: () => handle.getBounds(),
      };
    },
    dispose,
  };
};
