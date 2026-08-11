/**
 * Remove terminal controls from process-owned text before host or model rendering.
 *
 * The control-sequence policy and single-line normalization are owned by `pi-cosmic-core`.
 */
export { sanitizeTerminalLine, stripTerminalControls as sanitizeTerminalText } from "pi-cosmic-core";
