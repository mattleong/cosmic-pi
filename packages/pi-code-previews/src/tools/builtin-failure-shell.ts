import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import type { CompactIssue } from "./compact-issues";
import { exitIssueMessage, exitStatusMeaning, outputFailureLine } from "./process-failure";
import { firstLineMessage } from "pi-cosmic-core/message-text";
import { escapeControlChars } from "../shared/terminal-text";

const EXITED = /^Command exited with code -?\d+$/u;
const ABORTED = "Command aborted";
// When the shell exited before the timeout and only its background processes kept the tool
// waiting, Pi adds a sentence saying so, which the timeout issue keeps as its detail.
const TIMED_OUT =
  /^Command timed out after (\d+(?:\.\d+)? seconds)(?:\. (The shell exited with code -?\d+ after \d+(?:\.\d+)? seconds, but .+))?$/u;

const beforeLast = (lines: string[]): string[] => {
  let end = lines.length - 1;
  while (end > 0 && Option.exists(Arr.get(lines, end - 1), (line) => Str.trim(line) === ""))
    end -= 1;
  return lines.slice(0, end);
};

/** Lines without an exit or timeout status, which the failure issue states in words. */
export function withoutReportedShellStatus(lines: string[]): string[] {
  const last = lines.at(-1) ?? "";
  return EXITED.test(last) || TIMED_OUT.test(last) ? beforeLast(lines) : lines;
}

export function withoutShellStatus(lines: string[]): string[] {
  const last = lines.at(-1) ?? "";
  return EXITED.test(last) || last === ABORTED || TIMED_OUT.test(last) ? beforeLast(lines) : lines;
}

export function shellFailure(details: string, lines: string[], retained: boolean) {
  const last = lines.at(-1) ?? details;
  const timeout = TIMED_OUT.exec(last);
  const issues: CompactIssue[] = [];
  let outcome: "error" | "cancelled" = "error";
  if (EXITED.test(last)) {
    const exitCode = Number(/-?\d+$/u.exec(last)?.[0]);
    const cause = outputFailureLine(lines.slice(0, -1)) ?? exitStatusMeaning(exitCode);
    issues.push({
      severity: "error",
      code: "shell-exit",
      message: exitIssueMessage(exitCode, cause),
    });
  } else if (last === ABORTED) outcome = "cancelled";
  else if (timeout) {
    const [, duration = "", shellExit] = timeout;
    issues.push({
      severity: "error",
      code: "shell-timeout",
      message: `Timed out after ${duration}`,
      ...(shellExit !== undefined && { detail: escapeControlChars(shellExit) }),
    });
  } else
    issues.push({
      severity: "error",
      code: "failure",
      message: firstLineMessage(details, "Command failed"),
    });
  const footer = retained
    ? undefined
    : /^\[(Showing .+\. Full output: .+)\]$/u.exec(beforeLast(lines).at(-1) ?? "")?.[1];
  if (footer) issues.push({ severity: "info", code: "shell-retained-output", message: footer });
  return { outcome, issues };
}
