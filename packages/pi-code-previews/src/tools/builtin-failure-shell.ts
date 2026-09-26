import type { CompactIssue } from "./compact-issues";
import { firstLineMessage } from "./compact-issues";

/** Classify only the terminal status appended by the builtin, never stdout alone. */
export function shellFailure(details: string, lines: string[]) {
  const last = lines.at(-1) ?? details;
  const issues: CompactIssue[] = [];
  let outcome: "error" | "cancelled" = "error";
  if (/^Command exited with code -?\d+$/u.test(last))
    issues.push({
      severity: "error",
      code: "shell-exit",
      message: last.replace("Command exited", "Exited"),
    });
  else if (last === "Command aborted") outcome = "cancelled";
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
