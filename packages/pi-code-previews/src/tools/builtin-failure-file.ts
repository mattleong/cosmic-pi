import type { BuiltinCompactTool } from "./builtin-subject";
import type { CompactIssue } from "./compact-issues";
import { firstLineMessage } from "pi-cosmic-core";

// The raw error line, with its code and path, stays in the expanded result.
const filesystemFailures = [
  ["ENOENT: no such file or directory, ", "File not found"],
  ["EACCES: permission denied, ", "Permission denied"],
  ["EPERM: operation not permitted, ", "This operation is not permitted"],
  ["Path not found: ", "Path not found"],
  ["Not a directory: ", "The target is not a folder"],
] as const;
// Pi's edit reports a failed access check as `Could not edit file: <path>. Error code: <code>.`
const EDIT_ACCESS = /^Could not edit file: .+\. Error code: (E[A-Z]+)\.$/u;

const oldText = (index: string | undefined) =>
  index === undefined ? "oldText" : `edits[${index}].oldText`;

/** Edit refusals carry a technical cause and the agent's recovery as expanded detail. */
const editFailures: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly code: string;
  readonly message: string;
  readonly detail?: (match: RegExpExecArray) => string;
}> = [
  {
    pattern:
      /^Found (\d+) occurrences of (?:edits\[(\d+)\]|the text) in .+\. (?:Each oldText|The text) must be unique\. Please provide more context to make it unique\.$/u,
    code: "edit-ambiguous",
    message: "The replacement text matches more than one location",
    detail: (match) =>
      `${oldText(match[2])} matched ${match[1]} places.\nAdd context to make it unique.`,
  },
  {
    pattern:
      /^Could not find (?:edits\[(\d+)\]|the exact text) in .+\. The (?:oldText|old text) must match exactly including all whitespace and newlines\.$/u,
    code: "edit-no-match",
    message: "The text to replace was not found",
    detail: (match) =>
      `${oldText(match[1])} was not found.\nMatch the original text, including whitespace.`,
  },
  {
    pattern:
      /^edits\[(\d+)\] and edits\[(\d+)\] overlap in .+\. Merge them into one edit or target disjoint regions\.$/u,
    code: "edit-overlap",
    message: "The requested edits overlap",
    detail: (match) =>
      `edits[${match[1]}] and edits[${match[2]}] overlap.\nMerge them or target disjoint regions.`,
  },
  {
    pattern: /^(?:edits\[(\d+)\]\.)?oldText must not be empty in .+\.$/u,
    code: "edit-empty",
    message: "The text to replace is empty",
    detail: (match) => `${oldText(match[1])} is empty.\nProvide the exact text to replace.`,
  },
  {
    // A single edit's refusal adds a sentence about likely causes.
    pattern:
      /^No changes made to .+\. The replacements? produced identical content\.(?: This might indicate .+)?$/u,
    code: "edit-unchanged",
    message: "The replacement would not change the file",
  },
];

function editFailure(details: string): CompactIssue | undefined {
  for (const { pattern, code, message, detail } of editFailures) {
    const match = pattern.exec(details);
    if (match)
      return { severity: "error", code, message, ...(detail && { detail: detail(match) }) };
  }
  return undefined;
}

export function fileFailure(tool: BuiltinCompactTool, details: string, lines: string[]) {
  const first = lines[0] ?? details;
  const errno = tool === "edit" ? EDIT_ACCESS.exec(first)?.[1] : undefined;
  const filesystem = filesystemFailures.find(
    ([prefix]) =>
      first.startsWith(prefix) || (errno !== undefined && prefix.startsWith(`${errno}: `)),
  );
  const issue: CompactIssue = filesystem
    ? { severity: "error", code: "filesystem", message: filesystem[1] }
    : ((tool === "edit" ? editFailure(details) : undefined) ?? {
        severity: "error",
        code: "failure",
        message: firstLineMessage(details, `${tool} failed`),
      });
  return { outcome: "error" as const, issues: [issue] };
}
