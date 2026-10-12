import type { OverlayOptions } from "@earendil-works/pi-tui";
import { screenViewport, type TerminalSize } from "../manager/viewport.ts";

const emptyTerminal = (): TerminalSize => ({ columns: 0, rows: 0 });

export const createScreenViewport = () => {
  let readTerminal = emptyTerminal;
  const getSize = () => screenViewport(readTerminal());
  const overlayOptions: OverlayOptions = {
    get anchor() {
      return getSize().inset ? "center" : "top-left";
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
    getHeight: () => getSize().height,
    overlayOptions,
  };
};
