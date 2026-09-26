import type { BuiltinCompactTool } from "./builtin-subject";
import type { CompactIssue } from "./compact-issues";
import { shellFailure } from "./builtin-failure-shell";
import { fileFailure } from "./builtin-failure-file";

/** Recognized builtin error envelopes get a human message; anything else shows its first line. */
export function builtinFailure(tool: BuiltinCompactTool, output: string) {
  const details = output || `${tool} failed`;
  const aborted: CompactIssue[] = [];
  if (details.trim() === "Operation aborted")
    return { outcome: "cancelled" as const, issues: aborted };
  const lines = details.trimEnd().split(/\r?\n/u);
  return tool === "bash" ? shellFailure(details, lines) : fileFailure(tool, details, lines);
}
