import type { CompactIssue } from "./compact-issues";
import { exitStatusMeaning, outputFailureLine } from "./process-failure";
import { firstLineMessage } from "pi-cosmic-core";

// The closing status lines Pi's bash appends to a failed command.
const EXITED = /^Command exited with code -?\d+$/u;
const ABORTED = "Command aborted";
const TIMED_OUT = /^Command timed out after \d+(?:\.\d+)? seconds$/u;

/** Lines before the final one, without the blank lines Pi puts before its closing status. */
const beforeLast = (lines: string[]): string[] => {
  let end = lines.length - 1;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
};

/**
 * Output without the status line Pi appends to a failed command, and the blank lines before it.
 * The shell's issue line already states that status.
 */
export function withoutShellStatus(lines: string[]): string[] {
  const last = lines.at(-1) ?? "";
  return EXITED.test(last) || last === ABORTED || TIMED_OUT.test(last) ? beforeLast(lines) : lines;
}

/**
 * Classify only the terminal status appended by the builtin, never stdout alone. `retained`
 * says structured details already name the saved full output.
 */
export function shellFailure(details: string, lines: string[], retained: boolean) {
  const last = lines.at(-1) ?? details;
  const issues: CompactIssue[] = [];
  let outcome: "error" | "cancelled" = "error";
  if (EXITED.test(last)) {
    // The status says only that it failed; the output's first failure line says why.
    const cause =
      outputFailureLine(lines.slice(0, -1)) ?? exitStatusMeaning(Number(/-?\d+$/u.exec(last)?.[0]));
    issues.push({
      severity: "error",
      code: "shell-exit",
      message: `${last.replace("Command exited", "Exited")}${cause ? `: ${cause}` : ""}`,
    });
  } else if (last === ABORTED) outcome = "cancelled";
  else if (TIMED_OUT.test(last))
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
  // Thrown bash errors lose structured details. Keep the retained-output location from Pi's
  // footer, which directly precedes the closing status.
  const footer = retained
    ? undefined
    : /^\[(Showing .+\. Full output: .+)\]$/u.exec(beforeLast(lines).at(-1) ?? "")?.[1];
  if (footer) issues.push({ severity: "info", code: "shell-retained-output", message: footer });
  return { outcome, issues };
}
