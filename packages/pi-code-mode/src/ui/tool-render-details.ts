/** Pure defensive normalization of `code_mode` render details. */
import { reconcileDetailCounts } from "./detail-counts.ts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  CompactAttentionSchema,
  CompactReceiptSchema,
  type CompactAttention,
} from "../tools/compact-evidence.ts";
import { MAX_NESTED_SUBJECT_LENGTH, normalizeNestedSubject } from "../tools/compact-subject.ts";
import {
  ExecutionReceiptsSchema,
  hasCompleteReadOnlyReceipts,
  hasConsistentExecutionReceipts,
  type ExecutionReceipts,
} from "../tools/execution-receipts.ts";
import {
  InitialPreviewPresentationSchema,
  ResultIdSchema,
  type InitialPreviewPresentation,
} from "../results/read-presentation.ts";
import {
  decodeOption,
  MAX_PROGRESS_ENTRIES,
  LiveChildTimingSchema,
  type CodeModeCallCounts,
  type CodeModeCallEntry,
} from "../tools/format.ts";

export interface CodeModeRenderDetails {
  /** Current (v3) ledger. Older or malformed ledgers are absent, so summaries decline. */
  readonly compactAttention?: CompactAttention;
  readonly initialPreview?: InitialPreviewPresentation;
  /** True only for a complete retained receipt ledger proving read-only success. */
  readonly receiptsReadOnly: boolean;
  readonly toolCalls: ReadonlyArray<CodeModeCallEntry>;
  readonly counts: CodeModeCallCounts;
  /** Current, internally consistent details eligible for lossless compact projection. */
  readonly compactEligible: boolean;
  readonly outputKind?: "text" | "structured";
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

const SubjectSchema = Schema.String.check(Schema.isMaxLength(MAX_NESTED_SUBJECT_LENGTH * 2));
const CallEntryInputSchema = Schema.Struct({
  compact: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
  tool: Schema.optional(Schema.Unknown),
  activity: Schema.optional(Schema.Unknown),
  subject: Schema.optional(Schema.Unknown),
  durationMs: Schema.optional(Schema.Unknown),
  liveTiming: Schema.optional(Schema.Unknown),
});
const RenderDetailsInputSchema = Schema.Struct({
  compactAttention: Schema.optional(Schema.Unknown),
  initialPreview: Schema.optional(Schema.Unknown),
  resultId: Schema.optional(Schema.Unknown),
  executionReceipts: Schema.optional(Schema.Unknown),
  toolCalls: Schema.optional(Schema.Unknown),
  counts: Schema.optional(Schema.Unknown),
  outputKind: Schema.optional(Schema.Unknown),
  cancelled: Schema.optional(Schema.Unknown),
  truncated: Schema.optional(Schema.Unknown),
});
const validInitialPreview = (
  preview: typeof InitialPreviewPresentationSchema.Type | undefined,
  resultId: string | undefined,
  receipts: ExecutionReceipts | undefined,
  counts: CodeModeCallCounts,
  countsAreConsistent: boolean,
  cancellationBlocksPreview: boolean,
  truncated: boolean,
  outputKind: "text" | "structured" | undefined,
): InitialPreviewPresentation | undefined => {
  if (
    preview === undefined ||
    resultId === undefined ||
    preview.id !== resultId ||
    !truncated ||
    outputKind === undefined ||
    cancellationBlocksPreview ||
    !countsAreConsistent ||
    receipts === undefined ||
    receipts.total !== counts.total ||
    counts.running !== 0 ||
    counts.queued !== 0 ||
    preview.offset !== 0 ||
    preview.offset > preview.end ||
    preview.end > preview.total ||
    (preview.next === null
      ? preview.end !== preview.total
      : preview.next !== preview.end || preview.end >= preview.total || preview.end === 0)
  )
    return undefined;
  const readOnly = hasCompleteReadOnlyReceipts(receipts);
  const receiptModeValid =
    preview.receiptMode === "none"
      ? receipts.total === 0
      : preview.receiptMode === "read-only"
        ? receipts.total > 0 && readOnly
        : receipts.total > 0 && !readOnly;
  return receiptModeValid ? preview : undefined;
};

const CallStatusSchema = Schema.Literals(["queued", "running", "completed", "error", "cancelled"]);
interface NormalizedCallEntry {
  readonly call?: CodeModeCallEntry;
  readonly malformed: boolean;
}
const decodeCallEntry = <Value>(value: Value): NormalizedCallEntry => {
  const entry = decodeOption(CallEntryInputSchema, value);
  if (entry === undefined) return { malformed: true };
  const compact = decodeOption(CompactReceiptSchema, entry.compact);
  const status = decodeOption(CallStatusSchema, entry.status);
  if (status === undefined) return { malformed: true };
  const activity = Predicate.isString(entry.activity)
    ? normalizeNestedSubject(entry.activity)
    : undefined;
  const durationMs = decodeOption(Schema.Natural, entry.durationMs);
  const liveTiming = decodeOption(LiveChildTimingSchema, entry.liveTiming);
  const subject = decodeOption(SubjectSchema, entry.subject);
  const base: CodeModeCallEntry = {
    ...(compact !== undefined && { compact }),
    tool: Predicate.isString(entry.tool) ? entry.tool : "",
    status,
  };
  return {
    malformed: entry.compact !== undefined && compact === undefined,
    call: {
      ...base,
      ...(activity !== undefined && { activity }),
      ...(subject !== undefined && { subject: normalizeNestedSubject(subject) }),
      ...(durationMs !== undefined && { durationMs }),
      ...(status === "running" && liveTiming !== undefined && { liveTiming }),
    },
  };
};

/** Decodes at most the visible row bound while preserving valid exact totals. */
export const decodeCodeModeRenderDetails = <Details>(details: Details): CodeModeRenderDetails => {
  const record = decodeOption(RenderDetailsInputSchema, details) ?? {};
  const rawCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const inspectedCalls = rawCalls.slice(0, MAX_PROGRESS_ENTRIES);
  const normalizedCalls = inspectedCalls.map((entry) => decodeCallEntry(entry));
  const toolCalls = normalizedCalls.flatMap(({ call }) => (call === undefined ? [] : [call]));
  const { counts, consistent } = reconcileDetailCounts(record, toolCalls);
  const outputKind =
    record.outputKind === "text" || record.outputKind === "structured"
      ? record.outputKind
      : undefined;
  const ledger = decodeOption(CompactAttentionSchema, record.compactAttention);
  // A malformed call receipt means some call details are missing.
  const compactAttention =
    ledger && normalizedCalls.some((entry) => entry.malformed)
      ? { ...ledger, incomplete: true }
      : ledger;
  const decodedReceipts = decodeOption(ExecutionReceiptsSchema, record.executionReceipts);
  const executionReceipts =
    decodedReceipts !== undefined &&
    hasConsistentExecutionReceipts(decodedReceipts) &&
    decodedReceipts.total === counts.total
      ? decodedReceipts
      : undefined;
  const receiptsReadOnly =
    executionReceipts !== undefined &&
    consistent &&
    executionReceipts.total === counts.total &&
    counts.running === 0 &&
    counts.queued === 0 &&
    hasCompleteReadOnlyReceipts(executionReceipts);
  const initialPreview = validInitialPreview(
    decodeOption(InitialPreviewPresentationSchema, record.initialPreview),
    decodeOption(ResultIdSchema, record.resultId),
    executionReceipts,
    counts,
    consistent,
    record.cancelled !== undefined && decodeOption(Schema.Boolean, record.cancelled) !== false,
    record.truncated === true,
    outputKind,
  );
  const normalized: CodeModeRenderDetails = {
    ...(compactAttention !== undefined && { compactAttention }),
    ...(initialPreview !== undefined && { initialPreview }),
    receiptsReadOnly,
    toolCalls,
    counts,
    compactEligible:
      Array.isArray(record.toolCalls) &&
      rawCalls.length <= MAX_PROGRESS_ENTRIES &&
      toolCalls.length === rawCalls.length &&
      toolCalls.every((call) => call.tool.length > 0) &&
      consistent &&
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
