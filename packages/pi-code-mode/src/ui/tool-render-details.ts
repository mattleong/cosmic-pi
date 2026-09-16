/** Pure defensive normalization of current and legacy `code_mode` render details. */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { FailurePresentationSchema, type FailurePresentation } from "../tools/failure-evidence.ts";
import {
  CompactReceiptSchema,
  CompactAttentionSchema,
  recoverCompactNotices,
  type CompactAttention,
} from "../tools/compact-evidence.ts";
import {
  McpEvidenceSchema,
  validMcpCoverage,
  isCompactPiTool,
  type McpEvidence,
} from "../tools/mcp-evidence.ts";
import { MAX_NESTED_SUBJECT_LENGTH, normalizeNestedSubject } from "../tools/compact-subject.ts";
import {
  countCallEntries,
  decodeOption,
  MAX_PROGRESS_ENTRIES,
  LiveChildTimingSchema,
  type CodeModeCallCounts,
  type CodeModeCallEntry,
} from "../tools/format.ts";

export interface CodeModeRenderDetails {
  readonly failurePresentation?: FailurePresentation;
  readonly compactAttention?: CompactAttention;
  readonly mcpEvidence?: McpEvidence;
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

const SubjectSchema = Schema.String.check(Schema.isMaxLength(MAX_NESTED_SUBJECT_LENGTH * 2));
const CallEntryInputSchema = Schema.Struct({
  compact: Schema.optional(Schema.Unknown),
  status: Schema.Literals(["queued", "running", "completed", "error", "cancelled"]),
  tool: Schema.optional(Schema.Unknown),
  activity: Schema.optional(Schema.Unknown),
  subject: Schema.optional(Schema.Unknown),
  durationMs: Schema.optional(Schema.Unknown),
  liveTiming: Schema.optional(Schema.Unknown),
});
const RenderDetailsInputSchema = Schema.Struct({
  failurePresentation: Schema.optional(Schema.Unknown),
  compactAttention: Schema.optional(Schema.Unknown),
  mcpEvidence: Schema.optional(Schema.Unknown),
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
  const liveTiming = decodeOption(LiveChildTimingSchema, entry.liveTiming);
  const subject = decodeOption(SubjectSchema, entry.subject);
  const compact = decodeOption(CompactReceiptSchema, entry.compact);
  const base: CodeModeCallEntry = {
    ...(compact !== undefined && { compact }),
    tool: Predicate.isString(entry.tool) ? entry.tool : "",
    status: entry.status,
  };
  return {
    ...base,
    ...(activity !== undefined && { activity }),
    ...(subject !== undefined && { subject: normalizeNestedSubject(subject) }),
    ...(durationMs !== undefined && { durationMs }),
    ...(entry.status === "running" && liveTiming !== undefined && { liveTiming }),
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
  const mcpEvidence = decodeOption(McpEvidenceSchema, record.mcpEvidence);
  const decodedAttention = decodeOption(CompactAttentionSchema, record.compactAttention);
  const malformedReceipt = inspectedCalls.some((entry) => {
    const decoded = decodeOption(CallEntryInputSchema, entry);
    return (
      decoded?.compact !== undefined &&
      decodeOption(CompactReceiptSchema, decoded.compact) === undefined
    );
  });
  const visibleOutcomes = { errors: 0, warnings: 0, cancelled: 0, uncertain: 0 };
  for (const call of toolCalls) {
    const outcome = call.compact?.outcome;
    if (outcome === "error") visibleOutcomes.errors++;
    else if (outcome === "warning") visibleOutcomes.warnings++;
    else if (outcome === "cancelled") visibleOutcomes.cancelled++;
    else if (outcome === "uncertain") visibleOutcomes.uncertain++;
  }
  const invalidAttention =
    decodedAttention !== undefined &&
    (decodedAttention.errors < visibleOutcomes.errors ||
      decodedAttention.warnings < visibleOutcomes.warnings ||
      decodedAttention.cancelled < visibleOutcomes.cancelled ||
      decodedAttention.uncertain < visibleOutcomes.uncertain ||
      decodedAttention.admitted !== total ||
      decodedAttention.started > total ||
      decodedAttention.observed > decodedAttention.started ||
      decodedAttention.errors +
        decodedAttention.warnings +
        decodedAttention.cancelled +
        decodedAttention.uncertain >
        decodedAttention.observed ||
      decodedAttention.unsupported > 0 ||
      (counts.running + counts.queued === 0 &&
        decodedAttention.started !== decodedAttention.observed) ||
      decodedAttention.observed < toolCalls.filter((call) => call.compact !== undefined).length);
  const missingReceipt =
    decodedAttention !== undefined &&
    toolCalls.some((call) => call.status === "completed" && call.compact === undefined);
  const malformedMcp =
    record.mcpEvidence !== undefined &&
    (mcpEvidence === undefined ||
      mcpEvidence.incomplete ||
      (counts.running + counts.queued === 0 && mcpEvidence.observed !== mcpEvidence.mcp) ||
      !validMcpCoverage(
        { ...mcpEvidence, unsupported: 0, pi: mcpEvidence.pi + mcpEvidence.unsupported },
        total,
      ));
  const compactAttention =
    malformedReceipt ||
    (record.compactAttention !== undefined && malformedMcp) ||
    invalidAttention ||
    missingReceipt ||
    (record.compactAttention !== undefined && decodedAttention === undefined)
      ? {
          ...(decodedAttention ?? {
            version: 1 as const,
            admitted: total,
            started: 0,
            unsupported: 0,
            observed: 0,
            errors: 0,
            warnings: 0,
            cancelled: 0,
            uncertain: 0,
            notices: recoverCompactNotices(record.compactAttention),
          }),
          incomplete: true,
        }
      : decodedAttention;
  const failurePresentation = decodeOption(FailurePresentationSchema, record.failurePresentation);
  const normalized: CodeModeRenderDetails = {
    ...(failurePresentation !== undefined && { failurePresentation }),
    ...(compactAttention !== undefined && { compactAttention }),
    ...(mcpEvidence !== undefined && { mcpEvidence }),
    toolCalls,
    totalToolCalls: total,
    counts,
    hasExactCounts,
    compactEligible:
      (compactAttention !== undefined ||
        record.mcpEvidence === undefined ||
        (mcpEvidence !== undefined &&
          validMcpCoverage(mcpEvidence, total) &&
          toolCalls.filter((call) => isCompactPiTool(call.tool)).length <= mcpEvidence.pi &&
          toolCalls.filter((call) => call.tool === "mcp.request").length <= mcpEvidence.mcp &&
          toolCalls.every((call) => isCompactPiTool(call.tool) || call.tool === "mcp.request"))) &&
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
