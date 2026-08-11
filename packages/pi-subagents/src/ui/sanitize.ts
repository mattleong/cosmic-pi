/** Remove terminal controls from child-owned text before host rendering; owned by `pi-cosmic-core`. */
export {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
