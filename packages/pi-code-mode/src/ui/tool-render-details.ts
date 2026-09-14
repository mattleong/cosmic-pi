/** Pure defensive normalization of current and legacy `code_mode` render details. */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  countCallEntries,
  decodeOption,
  MAX_PROGRESS_ENTRIES,
  type CodeModeCallCounts,
  type CodeModeCallEntry,
} from "../tools/format.ts";

export interface CodeModeRenderDetails {
  readonly toolCalls: ReadonlyArray<CodeModeCallEntry>;
  readonly totalToolCalls: number;
  readonly counts: CodeModeCallCounts;
  readonly hasExactCounts: boolean;
  /** Current, internally consistent details eligible for lossless compact projection. */
  readonly compactEligible: boolean;
  readonly outputKind?: "text" | "structured";
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

const CallEntryInputSchema = Schema.Struct({
  status: Schema.Literals(["queued", "running", "completed", "error", "cancelled"]),
  tool: Schema.optional(Schema.Unknown),
  activity: Schema.optional(Schema.Unknown),
  durationMs: Schema.optional(Schema.Unknown),
});
const RenderDetailsInputSchema = Schema.Struct({
  toolCalls: Schema.optional(Schema.Unknown),
  totalToolCalls: Schema.optional(Schema.Unknown),
  counts: Schema.optional(Schema.Unknown),
  outputKind: Schema.optional(Schema.Unknown),
  cancelled: Schema.optional(Schema.Unknown),
  truncated: Schema.optional(Schema.Unknown),
});
const CallCountsInputSchema = Schema.Struct({
  total: Schema.Natural,
  queued: Schema.Natural,
  running: Schema.Natural,
  succeeded: Schema.Natural,
  failed: Schema.Natural,
  cancelled: Schema.Natural,
});

const nonNegativeInteger = <Value>(value: Value): number | undefined =>
  decodeOption(Schema.Natural, value);

const decodeCallEntry = <Value>(value: Value): CodeModeCallEntry | undefined => {
  const entry = decodeOption(CallEntryInputSchema, value);
  if (entry === undefined) return undefined;
  const activity = Predicate.isString(entry.activity) ? entry.activity : undefined;
  const durationMs = nonNegativeInteger(entry.durationMs);
  const base: CodeModeCallEntry = {
    tool: Predicate.isString(entry.tool) ? entry.tool : "",
    status: entry.status,
  };
  return {
    ...base,
    ...(activity !== undefined && { activity }),
    ...(durationMs !== undefined && { durationMs }),
  };
};

/** Decodes at most the visible row bound while preserving valid exact or legacy totals. */
export const decodeCodeModeRenderDetails = <Details>(details: Details): CodeModeRenderDetails => {
  const record = decodeOption(RenderDetailsInputSchema, details) ?? {};
  const rawCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const inspectedCalls = rawCalls.slice(0, MAX_PROGRESS_ENTRIES);
  const toolCalls = inspectedCalls.flatMap((entry) => {
    const decoded = decodeCallEntry(entry);
    return decoded === undefined ? [] : [decoded];
  });
  const legacyArrayTotal = toolCalls.length === inspectedCalls.length ? rawCalls.length : 0;
  const decodedTotal = nonNegativeInteger(record.totalToolCalls);
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
  const outputKind =
    record.outputKind === "text" || record.outputKind === "structured"
      ? record.outputKind
      : undefined;
  const normalized: CodeModeRenderDetails = {
    toolCalls,
    totalToolCalls: total,
    counts,
    hasExactCounts,
    compactEligible:
      Array.isArray(record.toolCalls) &&
      rawCalls.length <= MAX_PROGRESS_ENTRIES &&
      toolCalls.length === rawCalls.length &&
      toolCalls.every((call) => call.tool.length > 0) &&
      rawCounts !== undefined &&
      rawCounts.total === suppliedCountTotal &&
      rawCounts.total === total &&
      rawCounts.total ===
        rawCounts.queued +
          rawCounts.running +
          rawCounts.succeeded +
          rawCounts.failed +
          rawCounts.cancelled &&
      (record.totalToolCalls === undefined || decodedTotal === rawCounts.total) &&
      (record.outputKind === undefined || outputKind !== undefined) &&
      (record.cancelled === undefined ||
        decodeOption(Schema.Boolean, record.cancelled) !== undefined) &&
      (record.truncated === undefined ||
        decodeOption(Schema.Boolean, record.truncated) !== undefined),
    cancelled: record.cancelled === true,
    truncated: record.truncated === true,
  };
  return outputKind === undefined ? normalized : { ...normalized, outputKind };
};
