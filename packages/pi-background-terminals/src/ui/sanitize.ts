import { stripTerminalControls } from "pi-cosmic-core";

/**
 * Remove terminal controls from process-owned text before host or model rendering.
 *
 * The control-sequence policy is owned by `pi-cosmic-core`; this module only adds the
 * background-terminal line normalization used by single-line host surfaces.
 */
export const sanitizeTerminalText = stripTerminalControls;

export const sanitizeTerminalLine = (text: string): string =>
  sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
