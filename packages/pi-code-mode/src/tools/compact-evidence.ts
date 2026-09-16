/** Execution-local, bounded presentation receipts. Raw arguments and results never persist. */
import * as Schema from "effect/Schema";
import { isCompactAttention, type CompactSummary } from "pi-code-previews";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { decodeOption } from "./format.ts";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Text = Schema.String.check(Schema.isMaxLength(1024));
const Labels = Schema.Array(Text).check(Schema.isMaxLength(8));
const Notice = Schema.Struct({
  kind: Schema.Literals(["warning", "error", "recovery"]),
  text: Text,
  expandedOnly: Schema.optionalKey(Schema.Literal(true)),
});
export const CompactReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  subject: Text,
  action: Schema.optional(Text),
  counters: Schema.optional(Labels),
  metadata: Schema.optional(Labels),
  outcome: Schema.Literals(["success", "warning", "error", "cancelled", "uncertain"]),
  notices: Schema.Array(Notice).check(Schema.isMaxLength(32)),
  deliveryFailed: Schema.Boolean,
});
export type CompactReceipt = typeof CompactReceiptSchema.Type;
export const CompactAttentionSchema = Schema.Struct({
  version: Schema.Literal(1),
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
const clean = (text: string) =>
  sanitizeDiagnosticContent(text, { maximumLength: Number.MAX_SAFE_INTEGER });
export const freezeReceipt = (receipt: CompactReceipt): CompactReceipt =>
  Object.freeze({
    ...receipt,
    ...(receipt.counters && { counters: Object.freeze([...receipt.counters]) }),
    ...(receipt.metadata && { metadata: Object.freeze([...receipt.metadata]) }),
    notices: Object.freeze(receipt.notices.map((notice) => Object.freeze({ ...notice }))),
  });

export const copyCompactAttention = (attention: CompactAttention): CompactAttention =>
  Object.freeze({
    ...attention,
    notices: Object.freeze(attention.notices.map((notice) => Object.freeze({ ...notice }))),
  });

/** Recover bounded valid notices even if replayed sibling fields fail validation. */
export const recoverCompactNotices = <Value>(value: Value): readonly (typeof Notice.Type)[] => {
  try {
    const record = decodeOption(Schema.Struct({ notices: Schema.optional(Schema.Unknown) }), value);
    if (!Array.isArray(record?.notices)) return [];
    return record.notices.slice(0, 32).flatMap((item) => {
      const notice = decodeOption(Notice, item);
      return notice === undefined ? [] : [{ ...notice, text: clean(notice.text) }];
    });
  } catch {
    return [];
  }
};

/** All methods are guarded: presentation must never change dispatch or output admission. */
export const makeCompactEvidence = (publish: (id: number, receipt: CompactReceipt) => void) => {
  const fibers = new Map<number, number>();
  const receipts = new Map<number, CompactReceipt>();
  const notices: Array<typeof Notice.Type> = [];
  let incomplete = false;
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
    if (notices.some((old) => old.kind === notice.kind && old.text === notice.text)) return;
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
        if (
          ![
            "pi.read",
            "pi.bash",
            "pi.powershell",
            "pi.edit",
            "pi.write",
            "pi.grep",
            "pi.find",
            "pi.ls",
            "mcp.request",
            "session.backgroundTask",
          ].includes(name)
        )
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
        // Preserve valid notices independently of malformed or oversized sibling fields.
        for (const notice of summary.notices ?? []) {
          const decoded = decodeOption(Notice, {
            kind: notice.kind,
            text: clean(notice.text),
            ...(notice.expandedOnly === true && { expandedOnly: true }),
          });
          if (decoded === undefined) incomplete = true;
          else attention(decoded);
        }
        // Failure bodies are not persisted. Make any lost diagnostic detail explicit.
        if (summary.failure !== undefined) {
          if (summary.failure.cause !== summary.failure.details) {
            const cause = decodeOption(Notice, {
              kind: "error",
              text: clean(summary.failure.cause),
            });
            if (cause !== undefined) attention(cause);
            else incomplete = true;
          } else incomplete = true;
        }
        // Failure.details may contain arbitrary output. Only bounded semantic fields survive.
        const candidate = {
          version: 1 as const,
          subject: clean(summary.subject),
          ...(summary.action !== undefined && { action: clean(summary.action) }),
          ...(summary.counters !== undefined && { counters: summary.counters.map(clean) }),
          ...(summary.metadata !== undefined && { metadata: summary.metadata.map(clean) }),
          ...(summary.outcome !== undefined && { outcome: summary.outcome }),
          notices: (summary.notices ?? []).map((notice) => ({
            kind: notice.kind,
            text: clean(notice.text),
            ...(notice.expandedOnly === true && { expandedOnly: true }),
          })),
          deliveryFailed: false,
        };
        const decoded = decodeOption(CompactReceiptSchema, candidate);
        if (decoded === undefined) {
          incomplete = true;
          return;
        }
        const receipt = freezeReceipt(decoded);
        if (!receipts.has(id)) {
          observed++;
          if (receipt.outcome === "error") errors++;
          if (receipt.outcome === "warning") warnings++;
          if (receipt.outcome === "cancelled") cancelled++;
          if (receipt.outcome === "uncertain") uncertain++;
        }
        receipts.set(id, receipt);
        for (const notice of receipt.notices) attention(notice);
        publish(id, receipt);
      }),
    deliveryFailure: (id: number | undefined) =>
      guard(() => {
        if (id === undefined) {
          incomplete = true;
          return;
        }
        const receipt = receipts.get(id);
        if (receipt === undefined) return;
        const notice = {
          kind: "recovery" as const,
          text: "An observed nested operation did not deliver its result to the program. It may already have completed; do not replay it to recover output.",
        };
        attention(notice);
        const updated = freezeReceipt({ ...receipt, deliveryFailed: true });
        receipts.set(id, updated);
        publish(id, updated);
      }),
    snapshot: (): CompactAttention =>
      Object.freeze({
        version: 1,
        admitted,
        started,
        unsupported,
        observed,
        errors,
        warnings,
        cancelled,
        uncertain,
        incomplete,
        notices: Object.freeze(notices.map((notice) => Object.freeze({ ...notice }))),
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
