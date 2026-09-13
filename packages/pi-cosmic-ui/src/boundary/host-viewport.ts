import type { OverlayAnchor, OverlayOptions } from "@earendil-works/pi-tui";
import { screenViewport, type TerminalSize } from "../manager/viewport.ts";

/** One instance per custom UI opening. Hosts retain all overlay lifecycle ownership. */
export const createScreenViewport = (fallbackAnchor: OverlayAnchor = "top-left") => {
  let readTerminal: () => TerminalSize = () => ({ columns: 0, rows: 0 });
  const getSize = () => screenViewport(readTerminal());
  // Pi 0.85.1 resolves overlayOptions callbacks only at mount. Its TUI retains this
  // object and reads these getters on each render; spreading it loses live sizing.
  const overlayOptions: OverlayOptions = {
    get anchor() {
      return getSize().inset ? "center" : fallbackAnchor;
    },
    get width() {
      return getSize().width;
    },
    get maxHeight() {
      return getSize().height;
    },
  };
  return {
    attach: (terminal: () => TerminalSize): void => {
      readTerminal = terminal;
    },
    getSize,
    getHeight: () => getSize().height,
    overlayOptions,
  };
};
