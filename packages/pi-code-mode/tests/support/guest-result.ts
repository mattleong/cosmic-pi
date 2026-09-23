import { CodeMode, type CodeModeResult } from "../../src/boundary/codemode-runtime.ts";
import type { CodeModeExecutionEnvironment } from "../../src/tools/execution.ts";

/** Observe guest values independently of host safety framing in budget tests. */
export const captureGuestResult = (
  execute: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = CodeMode.execute,
) => {
  let latest: CodeModeResult | undefined;
  const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (options) =>
    execute({
      ...options,
      onResult: (result) => {
        latest = result;
        options.onResult?.(result);
      },
    });
  return {
    executeCodeMode,
    value: () => (latest?.ok ? latest.value : undefined),
  };
};
