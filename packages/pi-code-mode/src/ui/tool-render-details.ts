/** Pure defensive normalization of current and legacy `code_mode` render details. */
import { reconcileDetailCounts } from "./detail-counts.ts";
import { reconcileReplayEvidence, replayCompactEligible } from "./replay-evidence.ts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { invocationIssues } from "../tools/issue-evidence.ts";
import { FailurePresentationSchema, type FailurePresentation } from "../tools/failure-evidence.ts";
import {
  CompactReceiptSchema,
  recoverCompactNotices,
  type CompactAttention,
} from "../tools/compact-evidence.ts";
import { type McpEvidence } from "../tools/mcp-evidence.ts";
import { MAX_NESTED_SUBJECT_LENGTH, normalizeNestedSubject } from "../tools/compact-subject.ts";
import {
  ExecutionReceiptsSchema,
  hasCompleteReadOnlyReceipts,
  hasConsistentExecutionReceipts,
  type ExecutionReceipts,
} from "../tools/execution-receipts.ts";
import type { InitialPreviewPresentation } from "../results/read-presentation.ts";
import { replayReceiptAttention, type ReceiptAttention } from "./receipt-attention.ts";
import {
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
  readonly initialPreview?: InitialPreviewPresentation;
  readonly receiptAttention?: ReceiptAttention;
  /** True only for a complete retained receipt ledger proving read-only success. */
  readonly receiptsReadOnly: boolean;
  /** Independently recovered notices, bounded by visible rows times the receipt notice limit. */
  readonly recoveredNotices?: CompactAttention["notices"];
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
  status: Schema.optional(Schema.Unknown),
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
  initialPreview: Schema.optional(Schema.Unknown),
  resultId: Schema.optional(Schema.Unknown),
  executionReceipts: Schema.optional(Schema.Unknown),
  toolCalls: Schema.optional(Schema.Unknown),
  totalToolCalls: Schema.optional(Schema.Unknown),
  counts: Schema.optional(Schema.Unknown),
  outputKind: Schema.optional(Schema.Unknown),
  cancelled: Schema.optional(Schema.Unknown),
  truncated: Schema.optional(Schema.Unknown),
});
const nonNegativeInteger = <Value>(value: Value): number | undefined =>
  decodeOption(Schema.Natural, value);
const OffsetSchema = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const ResultIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const InitialPreviewInputSchema = Schema.Struct({
  status: Schema.Literal("page"),
  id: ResultIdSchema,
  originalOutcome: Schema.Literal("succeeded"),
  kind: Schema.Literal("output"),
  offset: OffsetSchema,
  end: OffsetSchema,
  next: Schema.NullOr(OffsetSchema),
  total: OffsetSchema,
  receiptMode: Schema.Literals(["none", "read-only", "full"]),
});

const validInitialPreview = (
  preview: typeof InitialPreviewInputSchema.Type | undefined,
  resultId: string | undefined,
  receipts: ExecutionReceipts | undefined,
  counts: CodeModeCallCounts,
  countsAreExactAndConsistent: boolean,
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
    !countsAreExactAndConsistent ||
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
  readonly notices: CompactAttention["notices"];
}
const decodeCallEntry = <Value>(value: Value): NormalizedCallEntry => {
  const entry = decodeOption(CallEntryInputSchema, value);
  if (entry === undefined) return { malformed: true, notices: [] };
  const compact = decodeOption(CompactReceiptSchema, entry.compact);
  const notices =
    compact === undefined
      ? recoverCompactNotices(entry.compact)
      : compact.notices.map((notice) => ({
          ...notice,
          text: sanitizeDiagnosticContent(notice.text, { maximumLength: Number.MAX_SAFE_INTEGER }),
        }));
  const status = decodeOption(CallStatusSchema, entry.status);
  if (status === undefined) return { malformed: true, notices };
  const activity = Predicate.isString(entry.activity)
    ? normalizeNestedSubject(entry.activity)
    : undefined;
  const durationMs = nonNegativeInteger(entry.durationMs);
  const liveTiming = decodeOption(LiveChildTimingSchema, entry.liveTiming);
  const subject = decodeOption(SubjectSchema, entry.subject);
  const base: CodeModeCallEntry = {
    ...(compact !== undefined && {
      compact: {
        ...compact,
        notices,
        ...(compact.version === 2 && {
          issues: invocationIssues(compact.issues) ?? { coverage: "unknown", entries: [] },
        }),
      },
    }),
    tool: Predicate.isString(entry.tool) ? entry.tool : "",
    status,
  };
  return {
    malformed: entry.compact !== undefined && compact === undefined,
    notices: compact === undefined ? notices : [],
    call: {
      ...base,
      ...(activity !== undefined && { activity }),
      ...(subject !== undefined && { subject: normalizeNestedSubject(subject) }),
      ...(durationMs !== undefined && { durationMs }),
      ...(status === "running" && liveTiming !== undefined && { liveTiming }),
    },
  };
};

/** Decodes at most the visible row bound while preserving valid exact or legacy totals. */
export const decodeCodeModeRenderDetails = <Details>(details: Details): CodeModeRenderDetails => {
  const record = decodeOption(RenderDetailsInputSchema, details) ?? {};
  const rawCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const inspectedCalls = rawCalls.slice(0, MAX_PROGRESS_ENTRIES);
  const normalizedCalls = inspectedCalls.map((entry) => decodeCallEntry(entry));
  const toolCalls = normalizedCalls.flatMap(({ call }) => (call === undefined ? [] : [call]));
  const recoveredNotices = normalizedCalls.flatMap(({ notices }) => notices);
  const { counts, total, hasExactCounts, consistent } = reconcileDetailCounts(
    record,
    toolCalls,
    inspectedCalls.length,
    rawCalls.length,
  );
  const outputKind =
    record.outputKind === "text" || record.outputKind === "structured"
      ? record.outputKind
      : undefined;
  const { mcpEvidence, compactAttention } = reconcileReplayEvidence(
    record,
    toolCalls,
    counts,
    normalizedCalls.some((entry) => entry.malformed),
  );
  const failurePresentation = decodeOption(FailurePresentationSchema, record.failurePresentation);
  const decodedReceipts = decodeOption(ExecutionReceiptsSchema, record.executionReceipts);
  const executionReceipts =
    decodedReceipts !== undefined &&
    hasConsistentExecutionReceipts(decodedReceipts) &&
    decodedReceipts.total === counts.total
      ? decodedReceipts
      : undefined;
  const receiptAttention = replayReceiptAttention(
    record.executionReceipts !== undefined,
    executionReceipts,
    compactAttention,
    toolCalls,
  );
  const receiptsReadOnly =
    executionReceipts !== undefined &&
    hasExactCounts &&
    consistent &&
    executionReceipts.total === counts.total &&
    counts.running === 0 &&
    counts.queued === 0 &&
    hasCompleteReadOnlyReceipts(executionReceipts);
  const initialPreview = validInitialPreview(
    decodeOption(InitialPreviewInputSchema, record.initialPreview),
    decodeOption(ResultIdSchema, record.resultId),
    executionReceipts,
    counts,
    hasExactCounts && consistent,
    record.cancelled !== undefined && decodeOption(Schema.Boolean, record.cancelled) !== false,
    record.truncated === true,
    outputKind,
  );
  const normalized: CodeModeRenderDetails = {
    ...(failurePresentation !== undefined && { failurePresentation }),
    ...(compactAttention !== undefined && { compactAttention }),
    ...(mcpEvidence !== undefined && { mcpEvidence }),
    ...(initialPreview !== undefined && { initialPreview }),
    ...(receiptAttention !== undefined && { receiptAttention }),
    receiptsReadOnly,
    toolCalls,
    recoveredNotices,
    totalToolCalls: total,
    counts,
    hasExactCounts,
    compactEligible:
      replayCompactEligible(record, toolCalls, total, mcpEvidence, compactAttention) &&
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
