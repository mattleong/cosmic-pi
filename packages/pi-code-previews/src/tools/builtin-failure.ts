import type { BuiltinCompactTool } from "./builtin-subject";
import type { CompactNotice, CompactFailureEvidence } from "./compact-summary";
import { shellFailure } from "./builtin-failure-shell";
import { fileFailure } from "./builtin-failure-file";

/** Only recognized builtin error envelopes are shortened. Unknown text stays intact. */
export function builtinFailure(tool: BuiltinCompactTool, output: string) {
  const details = output || `${tool} failed`;
  const lines = details.trimEnd().split(/\r?\n/u);
  const emptyNotices: CompactNotice[] = [];
  const classified =
    details.trim() === "Operation aborted"
      ? {
          cause: "Cancelled",
          description: "Cancelled.",
          outcome: "cancelled" as const,
          code: "cancelled",
          notices: emptyNotices,
          complete: true,
        }
      : tool === "bash"
        ? shellFailure(details, lines)
        : fileFailure(tool, details, lines);
  const { cause, description, outcome, code, notices, complete } = classified;
  const failureEvidence: CompactFailureEvidence | undefined =
    code === undefined ? undefined : { code, cause, coverage: complete ? "complete" : "unknown" };
  return {
    outcome,
    failure: { cause, description, details },
    notices,
    ...(failureEvidence && { failureEvidence }),
  };
}
