import type { BuiltinCompactTool } from "./builtin-compact-summary";
import type { CompactNotice } from "./compact-summary";

type Classification = {
  cause: string;
  description: string;
  code: string;
  notices: CompactNotice[];
};

const filesystemFailures = [
  ["ENOENT: no such file or directory, ", "File not found · ENOENT", "File not found."],
  ["EACCES: permission denied, ", "Permission denied · EACCES", "Permission denied."],
  [
    "EPERM: operation not permitted, ",
    "Operation not permitted · EPERM",
    "This operation is not permitted.",
  ],
  ["Path not found: ", "Path not found", "Path not found."],
  ["Not a directory: ", "Not a directory", "The target is not a folder."],
] as const;

function editFailure(details: string): Classification | undefined {
  const duplicate =
    /^Found (\d+) occurrences of (?:edits\[(\d+)\]|the text) in .+\. (?:Each oldText|The text) must be unique\. Please provide more context to make it unique\.$/u.exec(
      details,
    );
  if (duplicate)
    return {
      code: "edit-ambiguous",
      cause: `${duplicate[2] === undefined ? "oldText" : `edits[${duplicate[2]}].oldText`} matched ${duplicate[1]} places.`,
      description: "The replacement text matches more than one location.",
      notices: [
        { code: "edit-add-context", kind: "recovery", text: "Add context to make it unique." },
      ],
    };
  const missing =
    /^Could not find (?:edits\[(\d+)\]|the exact text) in .+\. The (?:oldText|old text) must match exactly including all whitespace and newlines\.$/u.exec(
      details,
    );
  if (missing)
    return {
      code: "edit-no-match",
      cause: `${missing[1] === undefined ? "oldText" : `edits[${missing[1]}].oldText`} was not found.`,
      description: "The text to replace was not found.",
      notices: [
        {
          code: "edit-match-original",
          kind: "recovery",
          text: "Match the original text, including whitespace.",
        },
      ],
    };
  const overlap =
    /^edits\[(\d+)\] and edits\[(\d+)\] overlap in .+\. Merge them into one edit or target disjoint regions\.$/u.exec(
      details,
    );
  if (overlap)
    return {
      code: "edit-overlap",
      cause: `edits[${overlap[1]}] and edits[${overlap[2]}] overlap.`,
      description: "The requested edits overlap.",
      notices: [
        {
          code: "edit-disjoint-regions",
          kind: "recovery",
          text: "Merge them or target disjoint regions.",
        },
      ],
    };
  if (/^No changes made to .+\. The replacements produced identical content\.$/u.test(details))
    return {
      code: "edit-unchanged",
      cause: "No changes made. The replacements produced identical content.",
      description: "The replacement would not change the file.",
      notices: [],
    };
  return undefined;
}

export function fileFailure(tool: BuiltinCompactTool, details: string, lines: string[]) {
  const first = lines[0] ?? details;
  const filesystem = filesystemFailures.find(([prefix]) => first.startsWith(prefix));
  const notices: CompactNotice[] = [];
  const classified = filesystem
    ? {
        cause: filesystem[1],
        description: filesystem[2],
        code: "filesystem",
        notices,
      }
    : tool === "edit"
      ? editFailure(details)
      : undefined;
  const failure = classified ?? {
    cause: details,
    description: "The tool reported an error.",
    code: undefined,
    notices,
  };
  const complete = failure.cause === details || lines.length <= 1;
  if (!complete) {
    // Unknown continuations may contain instructions or evidence of side effects.
    const tail = lines.slice(1).join("\n").trim();
    if (tail)
      failure.notices.push({ code: "unclassified-continuation", kind: "recovery", text: tail });
  }
  return { ...failure, outcome: "error" as const, complete };
}
