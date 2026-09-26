/** Execution-local, bounded presentation receipts. Raw arguments and results never persist. */
import * as Schema from "effect/Schema";
import {
  isCompactAttention,
  legacyCompactIssues,
  type CompactIssue,
  type CompactSummary,
} from "pi-code-previews";
import { freezeSnapshot } from "pi-cosmic-core";
import {
  BoundedIssuesSchema,
  cleanDiagnosticText as clean,
  invocationIssues,
} from "./issue-evidence.ts";
import { decodeOption } from "./format.ts";
import { isCompactPiTool } from "./compact-subject.ts";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Text = Schema.String.check(Schema.isMaxLength(1024));
const Labels = Schema.Array(Text).check(Schema.isMaxLength(8));
const Notice = Schema.Struct({
  kind: Schema.Literals(["warning", "error", "recovery"]),
  text: Text,
  expandedOnly: Schema.optionalKey(Schema.Literal(true)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
});
export const FailureEvidenceSchema = Schema.Struct({
  code: Text,
  cause: Text,
  coverage: Schema.Literals(["complete", "unknown"]),
});
export const CompactReceiptSchema = Schema.Struct({
  version: Schema.Literal(2),
  issues: BoundedIssuesSchema,
  failureEvidence: Schema.optionalKey(FailureEvidenceSchema),
  subject: Text,
  compactSubject: Schema.optionalKey(Text),
  action: Schema.optional(Text),
  counters: Schema.optional(Labels),
  metadata: Schema.optional(Labels),
  outcome: Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]),
  notices: Schema.Array(Notice).check(Schema.isMaxLength(32)),
  deliveryFailed: Schema.Boolean,
});
export type CompactReceipt = typeof CompactReceiptSchema.Type;
export const CompactAttentionSchema = Schema.Struct({
  version: Schema.Literal(2),
  issues: BoundedIssuesSchema,
  admitted: Count,
  started: Count,
  unsupported: Count,
  observed: Count,
  errors: Count,
  warnings: Count,
  cancelled: Count,
  uncertain: Count,
  incomplete: Schema.Boolean,
  notices: Schema.Array(Notice).check(Schema.isMaxLength(32)),
});
export type CompactAttention = typeof CompactAttentionSchema.Type;
export const INCOMPLETE_ATTENTION =
  "Nested presentation evidence is incomplete or exceeded its warning limit. Some recovery information is unavailable; check operation state and do not replay completed work to recover output.";
const cleanNotice = (notice: NonNullable<CompactSummary["notices"]>[number]) => ({
  kind: notice.kind,
  text: clean(notice.text),
  ...(notice.description !== undefined && { description: clean(notice.description) }),
  ...(notice.expandedOnly === true && { expandedOnly: true as const }),
});
/** Recover bounded valid notices even if replayed sibling fields fail validation. */
export const recoverCompactNotices = <Value>(value: Value): readonly (typeof Notice.Type)[] => {
  try {
    const record = decodeOption(
      Schema.Struct({
        notices: Schema.optional(Schema.Unknown),
        issues: Schema.optional(Schema.Unknown),
      }),
      value,
    );
    const issueRecord = decodeOption(
      Schema.Struct({ entries: Schema.optional(Schema.Unknown) }),
      record?.issues,
    );
    const recovered = (
      Array.isArray(issueRecord?.entries) ? issueRecord.entries.slice(0, 32) : []
    ).flatMap((entry) => {
      const collection = decodeOption(BoundedIssuesSchema, {
        coverage: "unknown",
        entries: [entry],
      });
      return (
        collection?.entries.flatMap((issue) => [
          ...(issue.cause ? [{ kind: issue.severity, text: clean(issue.cause) }] : []),
          ...issue.recovery.map((item) => ({ kind: "recovery" as const, text: clean(item.text) })),
          ...(issue.diagnostics ?? []).map((text) => ({
            kind: "recovery" as const,
            text: clean(text),
            expandedOnly: true as const,
          })),
        ]) ?? []
      );
    });
    return [
      ...recovered,
      ...(Array.isArray(record?.notices) ? record.notices : []).slice(0, 32).flatMap((item) => {
        const notice = decodeOption(Notice, item);
        return notice === undefined ? [] : [{ ...notice, text: clean(notice.text) }];
      }),
    ].slice(0, 32);
  } catch {
    return [];
  }
};

/** Validate the semantic receipt independently of aggregate notice salvage. */
const decodeSummaryReceipt = (
  summary: CompactSummary,
  failureEvidence: typeof FailureEvidenceSchema.Type | undefined,
  projectedIssues: ReturnType<typeof invocationIssues>,
  semanticNotices: NonNullable<CompactSummary["notices"]>,
) => {
  // Failure.details may contain arbitrary output. Only bounded semantic fields survive.
  const candidate = {
    version: 2 as const,
    issues: projectedIssues ?? { coverage: "unknown", entries: [] },
    ...(failureEvidence && {
      failureEvidence: { ...failureEvidence, cause: clean(failureEvidence.cause) },
    }),
    subject: clean(summary.subject),
    ...(summary.compactSubject !== undefined && {
      compactSubject: clean(summary.compactSubject),
    }),
    ...(summary.action !== undefined && { action: clean(summary.action) }),
    ...(summary.counters !== undefined && { counters: summary.counters.map(clean) }),
    ...(summary.metadata !== undefined && { metadata: summary.metadata.map(clean) }),
    ...(summary.outcome !== undefined && { outcome: summary.outcome }),
    notices: semanticNotices.map(cleanNotice),
    deliveryFailed: false,
  };
  return decodeOption(CompactReceiptSchema, candidate);
};

/** All methods are guarded: presentation must never change dispatch or output admission. */
export const makeCompactEvidence = (publish: (id: number, receipt: CompactReceipt) => void) => {
  const fibers = new Map<number, number>();
  const receipts = new Map<number, CompactReceipt>();
  const notices: Array<typeof Notice.Type> = [];
  const issues: CompactIssue[] = [];
  const retainIssues = (entries: readonly CompactIssue[]) => {
    for (const issue of entries) {
      if (issues.length >= 32) incomplete = true;
      else issues.push(issue);
    }
  };
  let incomplete = false;
  let issueCoverage: "complete" | "unknown" = "complete";
  let observed = 0;
  let admitted = 0;
  let started = 0;
  let unsupported = 0;
  let errors = 0;
  let warnings = 0;
  let cancelled = 0;
  let uncertain = 0;
  let closed = false;
  const guard = (f: () => void) => {
    if (closed) return;
    try {
      f();
    } catch {
      incomplete = true;
    }
  };
  const attention = (notice: typeof Notice.Type) => {
    if (!isCompactAttention(notice)) return;

    if (notices.length >= 32) {
      incomplete = true;
      return;
    }
    notices.push(Object.freeze({ ...notice }));
  };
  return {
    admit: (name: string) =>
      guard(() => {
        admitted++;
        if (!isCompactPiTool(name) && name !== "mcp.request" && name !== "session.backgroundTask")
          unsupported++;
      }),
    start: (fiber: number, id: number) =>
      guard(() => {
        started++;
        const previous = fibers.get(fiber);
        if (previous !== undefined) {
          incomplete = true;
          fibers.delete(fiber);
          receipts.delete(previous);
          return;
        }
        fibers.set(fiber, id);
      }),
    identity: (fiber: number): number | undefined => (closed ? undefined : fibers.get(fiber)),
    end: (fiber: number) =>
      guard(() => {
        const id = fibers.get(fiber);
        fibers.delete(fiber);
        if (id !== undefined) {
          if (!receipts.has(id)) incomplete = true;
          receipts.delete(id);
        }
      }),
    missing: () =>
      guard(() => {
        incomplete = true;
      }),
    observe: (id: number | undefined, project: () => CompactSummary | undefined) =>
      guard(() => {
        if (id === undefined) {
          incomplete = true;
          return;
        }
        if (receipts.has(id) || ![...fibers.values()].includes(id)) {
          incomplete = true;
          return;
        }
        const summary = project();
        if (summary === undefined) {
          incomplete = true;
          return;
        }
        const failureEvidence = decodeOption(FailureEvidenceSchema, summary.failureEvidence);
        const causeNotice =
          failureEvidence && summary.outcome !== "cancelled"
            ? { kind: "error" as const, text: clean(failureEvidence.cause) }
            : undefined;
        if (causeNotice) {
          const cause = decodeOption(Notice, causeNotice);
          if (cause) attention(cause);
          else incomplete = true;
        }
        // Preserve valid notices independently of malformed or oversized sibling fields.
        for (const notice of summary.notices ?? []) {
          const decoded = decodeOption(Notice, cleanNotice(notice));
          if (decoded === undefined) incomplete = true;
          else attention(decoded);
        }
        // Only producer-authored semantic causes survive; diagnostic bodies never persist.
        if (summary.failure !== undefined && failureEvidence?.coverage !== "complete")
          incomplete = true;
        if (summary.failureEvidence !== undefined && failureEvidence === undefined)
          incomplete = true;
        const semanticNotices = [...(causeNotice ? [causeNotice] : []), ...(summary.notices ?? [])];
        const projectedIssues = invocationIssues(
          summary.issues ??
            legacyCompactIssues(semanticNotices.filter(isCompactAttention), "legacy"),
          id,
        );
        if (!projectedIssues) incomplete = true;
        if (projectedIssues?.coverage !== "complete") issueCoverage = "unknown";
        retainIssues(projectedIssues?.entries ?? []);
        const decoded = decodeSummaryReceipt(
          summary,
          failureEvidence,
          projectedIssues,
          semanticNotices,
        );
        if (decoded === undefined) {
          incomplete = true;
          return;
        }
        const receipt = freezeSnapshot(decoded);
        if (!receipts.has(id)) {
          observed++;
          if (receipt.outcome === "error") errors++;
          if (receipt.outcome === "warning") warnings++;
          if (receipt.outcome === "cancelled") cancelled++;
          if (receipt.outcome === "uncertain") uncertain++;
        }
        receipts.set(id, receipt);

        publish(id, receipt);
      }),
    deliveryFailure: (id: number | undefined) =>
      guard(() => {
        if (id === undefined) {
          incomplete = true;
          return;
        }
        const receipt = receipts.get(id);
        if (receipt === undefined || receipt.deliveryFailed) return;
        const notice = {
          kind: "recovery" as const,
          text: `Observed nested call ${id} did not deliver its result to the program. It may already have completed; do not replay it to recover output.`,
        };
        attention(notice);
        const deliveryIssue: CompactIssue = {
          operation: `call-${id}/delivery`,
          code: "delivery-failed",
          severity: "warning",
          cause: notice.text,
          description: "An operation may have finished, but its result did not reach the program.",
          recovery: [],
        };
        retainIssues([deliveryIssue]);
        const hasCapacity = receipt.notices.length < 32;
        if (!hasCapacity) incomplete = true;
        const updated = freezeSnapshot<CompactReceipt>({
          ...receipt,
          deliveryFailed: true,
          issues: {
            coverage:
              receipt.issues.entries.length >= 32 ? ("unknown" as const) : receipt.issues.coverage,
            entries: [...receipt.issues.entries, deliveryIssue].slice(0, 32),
          },
          notices: hasCapacity ? [...receipt.notices, notice] : receipt.notices,
        });
        receipts.set(id, updated);
        publish(id, updated);
      }),
    snapshot: (): CompactAttention =>
      freezeSnapshot({
        version: 2,
        issues: { coverage: incomplete ? "unknown" : issueCoverage, entries: issues },
        admitted,
        started,
        unsupported,
        observed,
        errors,
        warnings,
        cancelled,
        uncertain,
        incomplete,
        notices,
      }),
    close: () => {
      if (closed) return;
      incomplete ||= started !== observed;
      closed = true;
      fibers.clear();
      receipts.clear();
    },
  };
};
