import * as Arr from "effect/Array";
import process from "node:process";

export function captureExplicitPreferenceArgument(args?: readonly string[]): boolean {
  try {
    const argv = args ?? process.argv.slice(2);
    const endOfOptions = argv.indexOf("--");
    return Arr.some(
      argv.slice(0, endOfOptions < 0 ? argv.length : endOfOptions).slice(0, -1),
      (argument) => argument === "--model" || argument === "--thinking",
    );
  } catch {
    return false;
  }
}
