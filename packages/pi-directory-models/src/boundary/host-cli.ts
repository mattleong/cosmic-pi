// Pi does not expose built-in CLI flag values to extensions, so this narrow host adapter
// detects the standard one-off --model argument from the process argv captured at startup.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import process from "node:process";

export function hasExplicitModelArgument(args: readonly string[]): boolean {
  return args.some((argument) => argument === "--model");
}

export function captureExplicitModelArgument(): boolean {
  try {
    return hasExplicitModelArgument(process.argv.slice(2));
  } catch {
    return false;
  }
}
