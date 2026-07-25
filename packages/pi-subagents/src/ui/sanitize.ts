import { stripTerminalControls } from "pi-cosmic-core";

/** Remove terminal controls from child-owned text before host rendering. */
export const sanitizeTerminalText = (text: string): string => stripTerminalControls(text);

export const sanitizeTerminalLine = (text: string): string =>
  sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
