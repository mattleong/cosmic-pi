import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CompactIssue } from "./compact-issues";
import { firstLineMessage } from "./issue-message";

// Output lines that name a failure: error words, failing tests, exception classes.
const CAUSE_WORD = /\b(?:error|errors|fail|failed|failure|failures|fatal|panic|panicked)\b/iu;
const CAUSE_CLASS = /[a-z](?:Error|Exception)\b/u;
const NO_CAUSE = /\b0 (?:errors?|fail(?:ed|ures?)?)\b/iu;
// Package-manager and make wrappers repeat the exit rather than its cause; stack frames follow it.
const WRAPPER =
  /^(?:npm (?:ERR!|error)|ELIFECYCLE\b|ERR_PNPM_|error Command failed|make(?:\[\d+\])?: \*\*\*|at |\[Showing )/u;
const CAUSE_LIMIT = 50;
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

/** The first output line that names the failure, redacted and bounded, when one does. */
function failureCause(output: readonly string[]): string | undefined {
  for (const raw of output) {
    const line = raw.trim();
    if (!line || WRAPPER.test(line) || NO_CAUSE.test(line)) continue;
    if (!CAUSE_WORD.test(line) && !CAUSE_CLASS.test(line)) continue;
    const cause = firstLineMessage(shortenCause(sanitizeDiagnosticContent(line)), "", CAUSE_LIMIT);
    if (cause) return cause;
  }
  return undefined;
}

/** Classify only the terminal status appended by the builtin, never stdout alone. */
export function shellFailure(details: string, lines: string[]) {
  const last = lines.at(-1) ?? details;
  const issues: CompactIssue[] = [];
  let outcome: "error" | "cancelled" = "error";
  if (/^Command exited with code -?\d+$/u.test(last)) {
    // The status says only that it failed; the output's first failure line says why.
    const cause = failureCause(lines.slice(0, -1));
    issues.push({
      severity: "error",
      code: "shell-exit",
      message: `${last.replace("Command exited", "Exited")}${cause ? `: ${cause}` : ""}`,
    });
  } else if (last === "Command aborted") outcome = "cancelled";
  else if (/^Command timed out after \d+(?:\.\d+)? seconds$/u.test(last))
    issues.push({
      severity: "error",
      code: "shell-timeout",
      message: last.replace("Command timed", "Timed"),
    });
  else
    issues.push({
      severity: "error",
      code: "failure",
      message: firstLineMessage(details, "Command failed"),
    });
  // Thrown bash errors lose structured details. Keep the retained-output location.
  for (const line of lines) {
    const retained = /^\[(Showing .+\. Full output: .+)\]$/u.exec(line);
    if (retained?.[1])
      issues.push({ severity: "info", code: "shell-retained-output", message: retained[1] });
  }
  return { outcome, issues };
}
