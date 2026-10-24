import { sanitizeDiagnosticError, sanitizeTerminalLine } from "pi-cosmic-core/security";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "./bounds.ts";
import type { BackgroundTaskSnapshot, BackgroundTaskStatus } from "./model.ts";

/** One terminal-safe line with recognized credentials redacted, or absent when nothing is left. */
export const redactedLine = (value: string | undefined, maximum: number): string | undefined => {
  const line = value === undefined ? "" : sanitizeTerminalLine(value);
  return line ? sanitizeDiagnosticError(line, { maximumLength: maximum }) : undefined;
};

/**
 * The snapshot persisted details keep. It holds the same short, redacted cause that the text
 * shows, so rendering never depends on result text a tool_result hook may have rewritten.
 */
export const detailsSnapshot = ({
  failureCause,
  ...snapshot
}: BackgroundTaskStatus): BackgroundTaskSnapshot => {
  const cause = redactedLine(failureCause, BACKGROUND_TASK_FIELD_BOUNDS.maxErrorChars);
  return cause === undefined ? snapshot : { ...snapshot, failureCause: cause };
};
