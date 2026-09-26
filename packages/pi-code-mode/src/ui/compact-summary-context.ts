/** Pure compact notice ownership and settled outcome policy over normalized details. */
import type { CompactNotice, CompactSummary } from "pi-code-previews";
import { INCOMPLETE_NOTICE } from "./notices.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

/**
 * The shared shell aggregates every child's issues, even rows omitted from the collapsed view,
 * so parent notices never echo ledger or child evidence on outer failures or pre-ledger replay.
 */
export const compactParentNotices = (details: CodeModeRenderDetails): CompactNotice[] => [
  ...(details.receiptAttention ? [details.receiptAttention.notice] : []),
  ...(details.recoveredNotices ?? []),
  ...(details.compactAttention?.incomplete ? [INCOMPLETE_NOTICE] : []),
];

export const compactSettledOutcome = (
  details: CodeModeRenderDetails,
  hasAttention: boolean,
): NonNullable<CompactSummary["outcome"]> => {
  const { failed, cancelled } = details.counts;
  return details.receiptAttention?.outcome === "uncertain" ||
    details.compactAttention?.incomplete ||
    details.compactAttention?.uncertain
    ? "uncertain"
    : details.receiptAttention?.outcome === "error" || details.compactAttention?.errors
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
