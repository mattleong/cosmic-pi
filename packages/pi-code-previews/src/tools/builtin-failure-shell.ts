import type { CompactIssue } from "./compact-issues";
import { firstLineMessage } from "./issue-message";
import { exitStatusMeaning, outputFailureLine } from "./process-failure";

/** Classify only the terminal status appended by the builtin, never stdout alone. */
export function shellFailure(details: string, lines: string[]) {
  const last = lines.at(-1) ?? details;
  const issues: CompactIssue[] = [];
  let outcome: "error" | "cancelled" = "error";
  if (/^Command exited with code -?\d+$/u.test(last)) {
    // The status says only that it failed; the output's first failure line says why.
    const cause =
      outputFailureLine(lines.slice(0, -1)) ?? exitStatusMeaning(Number(/-?\d+$/u.exec(last)?.[0]));
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
