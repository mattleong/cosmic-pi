import type { BuiltinCompactTool } from "./builtin-compact-summary";
import type { CompactNotice, CompactFailureEvidence } from "./compact-summary";

/** Only recognized builtin error envelopes are shortened. Unknown text stays intact. */
export function builtinFailure(tool: BuiltinCompactTool, output: string) {
  const details = output || `${tool} failed`;
  const lines = details.trimEnd().split(/\r?\n/u);
  const first = lines[0] ?? details;
  const last = lines.at(-1) ?? details;
  const notices: CompactNotice[] = [];
  let cause = details;
  let outcome: "error" | "cancelled" = "error";
  let code: string | undefined;
  let complete = true;

  if (details.trim() === "Operation aborted") {
    cause = "Cancelled";
    outcome = "cancelled";
    code = "cancelled";
  } else if (tool === "bash") {
    // The builtin appends this terminal status after output. Never infer it from stdout alone.
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
    if (cause !== details) {
      // Thrown bash errors lose structured details. Keep its raw truncation/recovery footer.
      for (const line of lines) {
        if (line.startsWith("[Showing ")) {
          if (!line.includes(". Full output: ") || !line.endsWith("]")) {
            // An unfamiliar footer may carry instructions we cannot safely hide.
            cause = details;
            code = undefined;
            notices.length = 0;
            break;
          }
          notices.push({
            code: "shell-retained-output",
            kind: "recovery",
            text: line,
            expandedInResult: true,
          });
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
    if (cause !== details) code = "filesystem";
    if (tool === "edit" && cause === details) {
      const duplicate =
        /^Found (\d+) occurrences of (?:edits\[(\d+)\]|the text) in .+\. (?:Each oldText|The text) must be unique\. Please provide more context to make it unique\.$/u.exec(
          details,
        );
      const missing =
        /^Could not find (?:edits\[(\d+)\]|the exact text) in .+\. The (?:oldText|old text) must match exactly including all whitespace and newlines\.$/u.exec(
          details,
        );
      const overlap =
        /^edits\[(\d+)\] and edits\[(\d+)\] overlap in .+\. Merge them into one edit or target disjoint regions\.$/u.exec(
          details,
        );
      if (duplicate) {
        code = "edit-ambiguous";
        cause = `${duplicate[2] === undefined ? "oldText" : `edits[${duplicate[2]}].oldText`} matched ${duplicate[1]} places.`;
        notices.push({
          code: "edit-add-context",
          kind: "recovery",
          text: "Add context to make it unique.",
          expandedInResult: true,
        });
      } else if (missing) {
        code = "edit-no-match";
        cause = `${missing[1] === undefined ? "oldText" : `edits[${missing[1]}].oldText`} was not found.`;
        notices.push({
          code: "edit-match-original",
          kind: "recovery",
          text: "Match the original text, including whitespace.",
          expandedInResult: true,
        });
      } else if (overlap) {
        code = "edit-overlap";
        cause = `edits[${overlap[1]}] and edits[${overlap[2]}] overlap.`;
        notices.push({
          code: "edit-disjoint-regions",
          kind: "recovery",
          text: "Merge them or target disjoint regions.",
          expandedInResult: true,
        });
      } else if (
        /^No changes made to .+\. The replacements produced identical content\.$/u.test(details)
      ) {
        code = "edit-unchanged";
        cause = "No changes made. The replacements produced identical content.";
      }
    }
    if (cause !== details && lines.length > 1) {
      complete = false;
      // Preserve unfamiliar continuations, including instructions and possible side effects.
      const tail = lines.slice(1).join("\n").trim();
      if (tail) notices.push({ code: "unclassified-continuation", kind: "recovery", text: tail });
    }
  }
  const failureEvidence: CompactFailureEvidence | undefined =
    code === undefined
      ? undefined
      : {
          code,
          cause,
          coverage: complete ? "complete" : "unknown",
        };
  return {
    outcome,
    failure: { cause, details },
    notices,
    ...(failureEvidence && { failureEvidence }),
  };
}
