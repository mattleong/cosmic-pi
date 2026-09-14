import type { BuiltinCompactTool } from "./builtin-compact-summary";
import type { CompactNotice } from "./compact-summary";

/** Only recognized builtin error envelopes are shortened. Unknown text stays intact. */
export function builtinFailure(tool: BuiltinCompactTool, output: string) {
  const details = output || `${tool} failed`;
  const lines = details.trimEnd().split(/\r?\n/u);
  const first = lines[0] ?? details;
  const last = lines.at(-1) ?? details;
  const notices: CompactNotice[] = [];
  let cause = details;
  let outcome: "error" | "cancelled" = "error";

  if (details.trim() === "Operation aborted") {
    cause = "Cancelled";
    outcome = "cancelled";
  } else if (tool === "bash") {
    // The builtin appends this terminal status after output. Never infer it from stdout alone.
    if (/^Command exited with code -?\d+$/u.test(last)) {
      cause = last.replace("Command exited", "Exited");
    } else if (last === "Command aborted") {
      cause = "Cancelled";
      outcome = "cancelled";
    } else if (/^Command timed out after \d+(?:\.\d+)? seconds$/u.test(last)) {
      cause = last.replace("Command timed", "Timed");
    }
    if (cause !== details) {
      // Thrown bash errors lose structured details. Keep its raw truncation/recovery footer.
      for (const line of lines) {
        if (line.startsWith("[Showing ")) {
          if (!line.includes(". Full output: ") || !line.endsWith("]")) {
            // An unfamiliar footer may carry instructions we cannot safely hide.
            cause = details;
            notices.length = 0;
            break;
          }
          notices.push({ kind: "recovery", text: line });
        }
      }
    }
  } else {
    if (first.startsWith("ENOENT: no such file or directory, ")) {
      cause = "File not found · ENOENT";
    } else if (first.startsWith("EACCES: permission denied, ")) {
      cause = "Permission denied · EACCES";
    } else if (first.startsWith("EPERM: operation not permitted, ")) {
      cause = "Operation not permitted · EPERM";
    } else if (first.startsWith("Path not found: ")) {
      cause = "Path not found";
    } else if (first.startsWith("Not a directory: ")) {
      cause = "Not a directory";
    }
    if (cause !== details && lines.length > 1) {
      // Preserve unfamiliar continuations, including instructions and possible side effects.
      const tail = lines.slice(1).join("\n").trim();
      if (tail) notices.push({ kind: "recovery", text: tail });
    }
  }
  return { outcome, failure: { cause, details }, notices };
}
