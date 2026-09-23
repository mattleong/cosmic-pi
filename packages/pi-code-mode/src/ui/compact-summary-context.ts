/** Pure compact notice ownership and settled outcome policy over normalized details. */
import type { CompactNotice, CompactSummary } from "pi-code-previews";
import { codeModeEvidenceNotices } from "./notices.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

export const compactParentNotices = (details: CodeModeRenderDetails): CompactNotice[] =>
  codeModeEvidenceNotices({
    ...details,
    ...(details.compactAttention?.version === 2 && {
      compactAttention: {
        ...details.compactAttention,
        notices: [],
        issues: { coverage: "complete", entries: [] },
      },
    }),
    // The shared shell aggregates every child, even rows omitted from the collapsed view.
    // Parent notices must not echo those facts on outer failures or legacy replay.
    toolCalls: details.toolCalls.map((call) => ({
      ...call,
      ...(call.compact && {
        compact: {
          ...call.compact,
          ...(call.compact.version === 2 && {
            issues: { coverage: "complete" as const, entries: [] },
          }),
          notices: [],
        },
      }),
    })),
  });

export const compactSettledOutcome = (
  details: CodeModeRenderDetails,
  hasAttention: boolean,
): NonNullable<CompactSummary["outcome"]> => {
  const evidence = details.mcpEvidence;
  const { failed, cancelled } = details.counts;
  return details.receiptAttention?.outcome === "uncertain" ||
    details.compactAttention?.incomplete ||
    details.compactAttention?.uncertain ||
    evidence?.unknown
    ? "uncertain"
    : details.receiptAttention?.outcome === "error" ||
        details.compactAttention?.errors ||
        evidence?.errors ||
        evidence?.notSent
      ? "error"
      : details.receiptAttention?.outcome === "warning" ||
          failed + cancelled > 0 ||
          details.compactAttention?.cancelled ||
          details.compactAttention?.warnings ||
          (details.truncated && details.initialPreview === undefined) ||
          hasAttention
        ? "warning"
        : "success";
};
