/** Reconcile visible lifecycle counts with exact and historical totals without losing evidence. */
import * as Schema from "effect/Schema";
import {
  countCallEntries,
  decodeOption,
  type CodeModeCallEntry,
  type CodeModeCallCounts,
} from "../tools/format.ts";

const CallCountsInputSchema = Schema.Struct({
  total: Schema.Natural,
  queued: Schema.Natural,
  running: Schema.Natural,
  succeeded: Schema.Natural,
  failed: Schema.Natural,
  cancelled: Schema.Natural,
});

export const reconcileDetailCounts = (
  record: { totalToolCalls?: unknown; counts?: unknown },
  toolCalls: readonly CodeModeCallEntry[],
  inspectedLength: number,
  rawLength: number,
) => {
  const legacyArrayTotal = toolCalls.length === inspectedLength ? rawLength : 0;
  const decodedTotal = decodeOption(Schema.Natural, record.totalToolCalls);
  const suppliedTotal = decodedTotal ?? 0;
  const rawCounts = decodeOption(CallCountsInputSchema, record.counts);
  const hasExactCounts = rawCounts !== undefined;
  const visible = countCallEntries(toolCalls);
  const { total: visibleTotal, ...visibleCounts } = visible;
  const suppliedCounts =
    rawCounts === undefined
      ? undefined
      : {
          queued: Math.max(visible.queued, rawCounts.queued),
          running: Math.max(visible.running, rawCounts.running),
          succeeded: Math.max(visible.succeeded, rawCounts.succeeded),
          failed: Math.max(visible.failed, rawCounts.failed),
          cancelled: Math.max(visible.cancelled, rawCounts.cancelled),
        };
  const suppliedCountTotal =
    suppliedCounts === undefined
      ? 0
      : Object.values(suppliedCounts).reduce((total, count) => total + count, 0);
  const total = Math.max(
    visibleTotal,
    legacyArrayTotal,
    suppliedTotal,
    rawCounts?.total ?? 0,
    suppliedCountTotal,
  );
  const hiddenLegacySucceeded = hasExactCounts ? 0 : Math.max(0, total - toolCalls.length);
  const counts: CodeModeCallCounts = hasExactCounts
    ? { total, ...(suppliedCounts ?? visibleCounts) }
    : { total, ...visibleCounts, succeeded: visible.succeeded + hiddenLegacySucceeded };
  const consistent =
    rawCounts !== undefined &&
    rawCounts.total === suppliedCountTotal &&
    rawCounts.total === total &&
    rawCounts.total ===
      rawCounts.queued +
        rawCounts.running +
        rawCounts.succeeded +
        rawCounts.failed +
        rawCounts.cancelled &&
    (record.totalToolCalls === undefined || decodedTotal === rawCounts.total);
  return { counts, total, hasExactCounts, consistent };
};
