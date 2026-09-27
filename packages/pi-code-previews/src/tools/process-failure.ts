/** Human causes for process failures: one output line, or what an exit status means. */
import { sanitizeDiagnosticContent, firstLineMessage } from "pi-cosmic-core";

// Output lines that name a failure: error words, failing tests, exception classes.
const CAUSE_WORD = /\b(?:error|errors|fail|failed|failure|failures|fatal|panic|panicked)\b/iu;
const CAUSE_CLASS = /[a-z](?:Error|Exception)\b/u;
const NO_CAUSE = /\b0 (?:errors?|fail(?:ed|ures?)?)\b/iu;
// Package-manager and make wrappers repeat the exit rather than its cause; stack frames follow it.
const WRAPPER =
  /^(?:npm (?:ERR!|error)|ELIFECYCLE\b|ERR_PNPM_|error Command failed|make(?:\[\d+\])?: \*\*\*|at |\[Showing )/u;
/** Longest output cause; shorter than a message so the status still leads. */
export const OUTPUT_FAILURE_LINE_LIMIT = 50;
// Compiler diagnostics lead with a location and a code; keep the file and line, drop the rest.
const LOCATION = /^(\S+?)(?:\((\d+),\d+\)|:(\d+)(?::\d+)?):\s+/u;
const SEVERITY_CODE = /^(?:error|fatal)(?:\[[\w-]+\]| TS\d+)?:\s*/iu;

const shortenCause = (line: string): string => {
  const location = LOCATION.exec(line);
  const rest = (location ? line.slice(location[0].length) : line).replace(SEVERITY_CODE, "");
  if (!location) return rest;
  const file = location[1]!.split(/[\\/]/u).at(-1);
  return `${file}:${location[2] ?? location[3]} ${rest}`;
};

/**
 * The first output line that names the failure, redacted and bounded, when one does. Package
 * manager wrappers, stack frames and zero-count summaries never qualify.
 */
export function outputFailureLine(output: readonly string[]): string | undefined {
  for (const raw of output) {
    const line = raw.trim();
    if (!line || WRAPPER.test(line) || NO_CAUSE.test(line)) continue;
    if (!CAUSE_WORD.test(line) && !CAUSE_CLASS.test(line)) continue;
    const cause = firstLineMessage(
      shortenCause(sanitizeDiagnosticContent(line)),
      "",
      OUTPUT_FAILURE_LINE_LIMIT,
    );
    if (cause) return cause;
  }
  return undefined;
}

const EXIT_MEANINGS = new Map([
  [126, "not executable"],
  [127, "command not found"],
  [130, "interrupted"],
  [137, "killed (possibly out of memory)"],
  [139, "crashed"],
  [143, "terminated"],
]);
const SIGNAL_MEANINGS = new Map([
  ["SIGABRT", "aborted"],
  ["SIGINT", "interrupted"],
  ["SIGKILL", "killed (possibly out of memory)"],
  ["SIGSEGV", "crashed"],
  ["SIGTERM", "terminated"],
]);

/** What a conventional exit code or signal means, for failures that print no cause. */
export function exitStatusMeaning(
  exitCode: number | null | undefined,
  signal?: string,
): string | undefined {
  return (
    (signal === undefined ? undefined : SIGNAL_MEANINGS.get(signal)) ??
    (exitCode == null ? undefined : EXIT_MEANINGS.get(exitCode))
  );
}
