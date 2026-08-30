// Pi does not expose built-in CLI flag values to extensions, so this narrow host adapter
// detects the standard one-off --model argument when the extension registers.
import process from "node:process";

export function captureExplicitModelArgument(args?: readonly string[]): boolean {
  try {
    const argv = args ?? process.argv.slice(2);
    return argv.includes("--model");
  } catch {
    return false;
  }
}
