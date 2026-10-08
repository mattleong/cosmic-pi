// Pi does not expose built-in CLI flag values to extensions, so this narrow host adapter
// detects one-off model or thinking preferences when the extension registers.
import process from "node:process";

export function captureExplicitPreferenceArgument(args?: readonly string[]): boolean {
  try {
    const argv = args ?? process.argv.slice(2);
    const endOfOptions = argv.indexOf("--");
    // A flag counts only when its value also precedes the end-of-options marker.
    return argv
      .slice(0, endOfOptions < 0 ? argv.length : endOfOptions)
      .slice(0, -1)
      .some((argument) => argument === "--model" || argument === "--thinking");
  } catch {
    return false;
  }
}
