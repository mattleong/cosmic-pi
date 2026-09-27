import type { CompactIssue } from "./compact-issues";
import { exitStatusMeaning, outputFailureLine } from "./process-failure";
import { firstLineMessage } from "pi-cosmic-core";

// The closing status lines Pi's bash appends to a failed command.
const EXITED = /^Command exited with code -?\d+$/u;
const ABORTED = "Command aborted";
const TIMED_OUT = /^Command timed out after \d+(?:\.\d+)? seconds$/u;

/**
 * Output without the status line Pi appends to a failed command, and the blank lines before it.
 * The shell's issue line already states that status.
 */
export function withoutShellStatus(lines: string[]): string[] {
  const last = lines.at(-1) ?? "";
  if (!EXITED.test(last) && last !== ABORTED && !TIMED_OUT.test(last)) return lines;
  let end = lines.length - 1;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
}

/** Classify only the terminal status appended by the builtin, never stdout alone. */
export function shellFailure(details: string, lines: string[]) {
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
  // Thrown bash errors lose structured details. Keep the retained-output location.
  for (const line of lines) {
    const retained = /^\[(Showing .+\. Full output: .+)\]$/u.exec(line);
    if (retained?.[1])
      issues.push({ severity: "info", code: "shell-retained-output", message: retained[1] });
  }
  return { outcome, issues };
}
