import type { BuiltinCompactTool } from "./builtin-subject";
import type { CompactIssue } from "./compact-issues";
import { firstLineMessage } from "./compact-issues";

// The raw error line, with its code and path, stays in the expanded result.
const filesystemFailures = [
  ["ENOENT: no such file or directory, ", "File not found"],
  ["EACCES: permission denied, ", "Permission denied"],
  ["EPERM: operation not permitted, ", "This operation is not permitted"],
  ["Path not found: ", "Path not found"],
  ["Not a directory: ", "The target is not a folder"],
] as const;

/** Edit refusals carry a technical cause and the agent's recovery as expanded detail. */
function editFailure(details: string): CompactIssue | undefined {
  const duplicate =
    /^Found (\d+) occurrences of (?:edits\[(\d+)\]|the text) in .+\. (?:Each oldText|The text) must be unique\. Please provide more context to make it unique\.$/u.exec(
      details,
    );
  if (duplicate)
    return {
      severity: "error",
      code: "edit-ambiguous",
      message: "The replacement text matches more than one location",
      detail: `${duplicate[2] === undefined ? "oldText" : `edits[${duplicate[2]}].oldText`} matched ${duplicate[1]} places.\nAdd context to make it unique.`,
    };
  const missing =
    /^Could not find (?:edits\[(\d+)\]|the exact text) in .+\. The (?:oldText|old text) must match exactly including all whitespace and newlines\.$/u.exec(
      details,
    );
  if (missing)
    return {
      severity: "error",
      code: "edit-no-match",
      message: "The text to replace was not found",
      detail: `${missing[1] === undefined ? "oldText" : `edits[${missing[1]}].oldText`} was not found.\nMatch the original text, including whitespace.`,
    };
  const overlap =
    /^edits\[(\d+)\] and edits\[(\d+)\] overlap in .+\. Merge them into one edit or target disjoint regions\.$/u.exec(
      details,
    );
  if (overlap)
    return {
      severity: "error",
      code: "edit-overlap",
      message: "The requested edits overlap",
      detail: `edits[${overlap[1]}] and edits[${overlap[2]}] overlap.\nMerge them or target disjoint regions.`,
    };
  if (/^No changes made to .+\. The replacements produced identical content\.$/u.test(details))
    return {
      severity: "error",
      code: "edit-unchanged",
      message: "The replacement would not change the file",
    };
  return undefined;
}

export function fileFailure(tool: BuiltinCompactTool, details: string, lines: string[]) {
  const first = lines[0] ?? details;
  const filesystem = filesystemFailures.find(([prefix]) => first.startsWith(prefix));
  const issue: CompactIssue = filesystem
    ? { severity: "error", code: "filesystem", message: filesystem[1] }
    : ((tool === "edit" ? editFailure(details) : undefined) ?? {
        severity: "error",
        code: "failure",
        message: firstLineMessage(details, `${tool} failed`),
      });
  return { outcome: "error" as const, issues: [issue] };
}
