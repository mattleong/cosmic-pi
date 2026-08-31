// Pi does not expose built-in CLI flag values to extensions, so this narrow host adapter
// detects one-off model or thinking preferences when the extension registers.
import process from "node:process";

export function captureExplicitPreferenceArgument(args?: readonly string[]): boolean {
  try {
    const argv = args ?? process.argv.slice(2);
    const endOfOptions = argv.indexOf("--");
    const optionCount = endOfOptions < 0 ? argv.length : endOfOptions;

    for (let index = 0; index + 1 < optionCount; index += 1) {
      const argument = argv[index];
      if (argument === "--model" || argument === "--thinking") return true;
    }
    return false;
  } catch {
    return false;
  }
}
