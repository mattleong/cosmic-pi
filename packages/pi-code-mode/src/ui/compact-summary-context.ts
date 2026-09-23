/** Pure compact notice ownership and settled outcome policy over normalized details. */
import { isCompactAttention, type CompactNotice, type CompactSummary } from "pi-code-previews";
import { codeModeEvidenceNotices } from "./notices.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

export const compactParentNotices = (
  details: CodeModeRenderDetails,
  isError: boolean,
): CompactNotice[] => {
  // Keep informational hints parent-owned when an outer failure bypasses details.
  const notices: CompactNotice[] =
    details.compactAttention?.version === 2
      ? codeModeEvidenceNotices({
          ...details,
          compactAttention: {
            ...details.compactAttention,
            notices: [],
            issues: { coverage: "complete", entries: [] },
          },
          toolCalls: details.toolCalls.map((call) => ({
            ...call,
            ...(call.compact && {
              compact: {
                ...call.compact,
                ...(call.compact.version === 2 && {
                  issues: { coverage: "complete" as const, entries: [] },
                }),
                notices: isError
                  ? call.compact.notices.filter((notice) => !isCompactAttention(notice))
                  : [],
              },
            }),
          })),
        })
      : codeModeEvidenceNotices(details);
  return notices;
};

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
