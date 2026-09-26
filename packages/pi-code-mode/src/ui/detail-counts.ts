/** Reconcile visible lifecycle rows with exact producer counts without understating either. */
import {
  CodeModeCallCountsSchema,
  countCallEntries,
  decodeOption,
  type CodeModeCallEntry,
} from "../tools/format.ts";

/** Details without decodable counts fall back to their visible rows and are never consistent. */
export const reconcileDetailCounts = (
  record: { counts?: unknown },
  toolCalls: readonly CodeModeCallEntry[],
) => {
  const visible = countCallEntries(toolCalls);
  const raw = decodeOption(CodeModeCallCountsSchema, record.counts);
  if (raw === undefined) return { counts: visible, consistent: false };
  const statuses = {
    queued: Math.max(visible.queued, raw.queued),
    running: Math.max(visible.running, raw.running),
    succeeded: Math.max(visible.succeeded, raw.succeeded),
    failed: Math.max(visible.failed, raw.failed),
    cancelled: Math.max(visible.cancelled, raw.cancelled),
  };
  const statusTotal = Object.values(statuses).reduce((total, count) => total + count, 0);
  return {
    counts: { total: Math.max(raw.total, statusTotal), ...statuses },
    consistent:
      raw.total === statusTotal &&
      statusTotal === raw.queued + raw.running + raw.succeeded + raw.failed + raw.cancelled,
  };
};
