import type { CompactNotice } from "./compact-summary";

/** Classify only the terminal status appended by the builtin, never stdout alone. */
export function shellFailure(details: string, lines: string[]) {
  const last = lines.at(-1) ?? details;
  let cause = details;
  let outcome: "error" | "cancelled" = "error";
  let code: string | undefined;
  if (/^Command exited with code -?\d+$/u.test(last)) {
    cause = last.replace("Command exited", "Exited");
    code = "shell-exit";
  } else if (last === "Command aborted") {
    cause = "Cancelled";
    outcome = "cancelled";
    code = "cancelled";
  } else if (/^Command timed out after \d+(?:\.\d+)? seconds$/u.test(last)) {
    cause = last.replace("Command timed", "Timed");
    code = "shell-timeout";
  }
  const notices: CompactNotice[] = [];
  if (cause !== details) {
    // Thrown bash errors lose structured details. Preserve retained-output recovery.
    for (const line of lines) {
      if (!line.startsWith("[Showing ")) continue;
      if (!line.includes(". Full output: ") || !line.endsWith("]")) {
        // Unknown footers withdraw coverage without changing cancellation evidence.
        cause = details;
        code = undefined;
        notices.length = 0;
        break;
      }
      notices.push({ code: "shell-retained-output", kind: "recovery", text: line });
    }
  }
  const description =
    outcome === "cancelled"
      ? "Cancelled."
      : code === undefined
        ? "The tool reported an error."
        : cause;
  return { cause, description, outcome, code, notices, complete: true };
}
