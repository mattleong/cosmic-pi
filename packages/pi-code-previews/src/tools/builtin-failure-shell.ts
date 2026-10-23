import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { CompactIssue } from "./compact-issues";
import { exitStatusMeaning, outputFailureLine } from "./process-failure";
import { firstLineMessage } from "pi-cosmic-core/message-text";

const EXITED = /^Command exited with code -?\d+$/u;
const ABORTED = "Command aborted";
const TIMED_OUT = /^Command timed out after \d+(?:\.\d+)? seconds$/u;

const beforeLast = (lines: string[]): string[] => {
  let end = lines.length - 1;
  while (end > 0 && Option.exists(Arr.get(lines, end - 1), (line) => Str.trim(line) === ""))
    end -= 1;
  return lines.slice(0, end);
};

export function withoutShellStatus(lines: string[]): string[] {
  const last = lines.at(-1) ?? "";
  return EXITED.test(last) || last === ABORTED || TIMED_OUT.test(last) ? beforeLast(lines) : lines;
}

export function shellFailure(details: string, lines: string[], retained: boolean) {
  const last = lines.at(-1) ?? details;
  const issues: CompactIssue[] = [];
  let outcome: "error" | "cancelled" = "error";
  if (EXITED.test(last)) {
    const cause =
      outputFailureLine(lines.slice(0, -1)) ?? exitStatusMeaning(Number(/-?\d+$/u.exec(last)?.[0]));
    issues.push({
      severity: "error",
      code: "shell-exit",
      message: `${Fn.pipe(last, Str.replace("Command exited", "Exited"))}${cause ? `: ${cause}` : ""}`,
    });
  } else if (last === ABORTED) outcome = "cancelled";
  else if (TIMED_OUT.test(last))
    issues.push({
      severity: "error",
      code: "shell-timeout",
      message: Fn.pipe(last, Str.replace("Command timed", "Timed")),
    });
  else
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
