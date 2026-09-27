/** Execution-local, bounded presentation receipts. Raw arguments and results never persist. */
import * as Schema from "effect/Schema";
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { freezeSnapshot, clipText } from "pi-cosmic-core";
import {
  BoundedIssuesSchema,
  MAX_RECEIPT_ISSUES,
  cleanDiagnosticText as clean,
  retainIssues,
} from "./issue-evidence.ts";
import { decodeOption } from "./format.ts";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const MAX_FIELD = 1024;
const MAX_LABELS = 8;
const Text = Schema.String.check(Schema.isMaxLength(MAX_FIELD));
const Labels = Schema.Array(Text).check(Schema.isMaxLength(MAX_LABELS));
const Outcome = Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]);

/** One nested call's display receipt. Version 3 replaced notices with one issue list. */
export const CompactReceiptSchema = Schema.Struct({
  version: Schema.Literal(3),
  subject: Text,
  compactSubject: Schema.optionalKey(Text),
  action: Schema.optionalKey(Text),
  counters: Schema.optionalKey(Labels),
  metadata: Schema.optionalKey(Labels),
  outcome: Outcome,
  issues: BoundedIssuesSchema,
  /** The result settled but never reached the program. */
  deliveryFailed: Schema.Boolean,
});
export type CompactReceipt = typeof CompactReceiptSchema.Type;

/** Execution-wide counts that survive row eviction. `incomplete` marks missing receipts. */
export const CompactAttentionSchema = Schema.Struct({
  version: Schema.Literal(3),
  errors: Count,
  warnings: Count,
  cancelled: Count,
  uncertain: Count,
  incomplete: Schema.Boolean,
});
export type CompactAttention = typeof CompactAttentionSchema.Type;

export const INCOMPLETE_ATTENTION =
  "Nested presentation evidence is incomplete. Check operation state and do not replay completed work to recover output.";

const deliveryIssue = (id: number): CompactIssue => ({
  severity: "warning",
  code: "delivery-failed",
  message: "The result did not reach the program",
  detail: `Nested call ${id} may already have completed; do not replay it to recover output.`,
});

/** Only bounded semantic fields survive; producer output and arguments never do. */
/** Display text is clipped to the receipt bounds so one long field cannot drop the call's issues. */
const text = (value: string) => clipText(clean(value), MAX_FIELD);
const labels = (values: readonly string[]) => values.slice(0, MAX_LABELS).map(text);

const receiptFromSummary = (summary: CompactSummary) => {
  const retained = retainIssues(summary.issues);
  const receipt = decodeOption(CompactReceiptSchema, {
    version: 3,
    subject: text(summary.subject),
    ...(summary.compactSubject !== undefined && { compactSubject: text(summary.compactSubject) }),
    ...(summary.action !== undefined && { action: text(summary.action) }),
    ...(summary.counters !== undefined && { counters: labels(summary.counters) }),
    ...(summary.metadata !== undefined && { metadata: labels(summary.metadata) }),
    outcome: summary.outcome ?? "uncertain",
    issues: retained.issues,
    deliveryFailed: false,
  });
  return receipt && { receipt, complete: !retained.dropped && summary.outcome !== undefined };
};

/** All methods are guarded: presentation must never change dispatch or output admission. */
export const makeCompactEvidence = (publish: (id: number, receipt: CompactReceipt) => void) => {
  const fibers = new Map<number, number>();
  const receipts = new Map<number, CompactReceipt>();
  let incomplete = false;
  let started = 0;
  let observed = 0;
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
  return {
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
        if (id === undefined || receipts.has(id) || ![...fibers.values()].includes(id)) {
          incomplete = true;
          return;
        }
        const summary = project();
        const retained = summary && receiptFromSummary(summary);
        if (!retained) {
          incomplete = true;
          return;
        }
        if (!retained.complete) incomplete = true;
        const receipt = freezeSnapshot(retained.receipt);
        observed++;
        if (receipt.outcome === "error") errors++;
        if (receipt.outcome === "warning") warnings++;
        if (receipt.outcome === "cancelled") cancelled++;
        if (receipt.outcome === "uncertain") uncertain++;
        receipts.set(id, receipt);
        publish(id, receipt);
      }),
    /** A call refused before its tool ran has no producer summary, only the refusal. */
    refused: (id: number, issue: CompactIssue) =>
      guard(() => {
        if (receipts.has(id)) return;
        const receipt = freezeSnapshot<CompactReceipt>({
          version: 3,
          subject: "",
          outcome: "error",
          issues: retainIssues([issue]).issues,
          deliveryFailed: false,
        });
        errors++;
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
        // At the bound, the delivery issue replaces the last producer issue and says so.
        const full = receipt.issues.length >= MAX_RECEIPT_ISSUES;
        if (full) incomplete = true;
        const updated = freezeSnapshot<CompactReceipt>({
          ...receipt,
          deliveryFailed: true,
          issues: [
            ...receipt.issues.slice(0, full ? MAX_RECEIPT_ISSUES - 1 : undefined),
            deliveryIssue(id),
          ],
        });
        receipts.set(id, updated);
        publish(id, updated);
      }),
    snapshot: (): CompactAttention =>
      freezeSnapshot({ version: 3, errors, warnings, cancelled, uncertain, incomplete }),
    close: () => {
      if (closed) return;
      incomplete ||= started !== observed;
      closed = true;
      fibers.clear();
      receipts.clear();
    },
  };
};
