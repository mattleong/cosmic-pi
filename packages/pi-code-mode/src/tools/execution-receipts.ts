import * as Schema from "effect/Schema";

const ReceiptCount = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const RECOVERY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ReceiptId = Schema.Int.check(
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const ExecutionReceiptSchema = Schema.Struct({
  id: ReceiptId,
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  target: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  certainty: Schema.Literals(["not-sent", "completed", "unknown"]),
  delivery: Schema.Literals(["pending", "delivered", "not-delivered"]),
  recoveryId: Schema.optionalKey(Schema.String.check(Schema.isPattern(RECOVERY_ID))),
  isError: Schema.optionalKey(Schema.Boolean),
});
export const ExecutionReceiptsSchema = Schema.Struct({
  total: ReceiptCount,
  completed: ReceiptCount,
  unknown: ReceiptCount,
  notSent: ReceiptCount,
  omitted: ReceiptCount,
  calls: Schema.Array(ExecutionReceiptSchema).check(Schema.isMaxLength(256)),
});

/** Operation facts, separate from UI severity and from guest delivery. No inputs or errors. */
export type ExecutionReceipts = typeof ExecutionReceiptsSchema.Type;
type ExecutionReceipt = ExecutionReceipts["calls"][number];
type Certainty = ExecutionReceipt["certainty"];

/** Cross-field consistency required before replaying receipt safety classifications. */
export const hasConsistentExecutionReceipts = (receipts: ExecutionReceipts): boolean =>
  receipts.completed + receipts.unknown + receipts.notSent === receipts.total &&
  receipts.total - receipts.calls.length === receipts.omitted &&
  new Set(receipts.calls.map((call) => call.id)).size === receipts.calls.length &&
  receipts.calls.filter((call) => call.certainty === "completed").length <= receipts.completed &&
  receipts.calls.filter((call) => call.certainty === "unknown").length <= receipts.unknown &&
  receipts.calls.filter((call) => call.certainty === "not-sent").length <= receipts.notSent;

const REDUCIBLE_READ_TOOLS = new Set(["pi.read", "pi.grep", "pi.find", "pi.ls"]);

/** Receipt reduction is allowed only for a complete, explicitly successful read-only ledger. */
export const hasCompleteReadOnlyReceipts = (receipts: ExecutionReceipts): boolean =>
  hasConsistentExecutionReceipts(receipts) &&
  receipts.calls.length === receipts.total &&
  receipts.completed === receipts.total &&
  receipts.unknown === 0 &&
  receipts.notSent === 0 &&
  receipts.calls.every(
    (call) =>
      REDUCIBLE_READ_TOOLS.has(call.tool) &&
      call.certainty === "completed" &&
      call.delivery === "delivered" &&
      call.isError === false,
  );

export type InitialReceiptProjection =
  | { readonly receiptMode: "none" }
  | {
      readonly receiptMode: "read-only";
      readonly evidence: { readonly total: number; readonly completed: number };
    }
  | { readonly receiptMode: "full"; readonly evidence: ExecutionReceipts };

export const projectInitialReceipts = (receipts: ExecutionReceipts): InitialReceiptProjection =>
  receipts.total === 0 && hasConsistentExecutionReceipts(receipts)
    ? { receiptMode: "none" }
    : hasCompleteReadOnlyReceipts(receipts)
      ? {
          receiptMode: "read-only",
          evidence: { total: receipts.total, completed: receipts.completed },
        }
      : { receiptMode: "full", evidence: receipts };

export function makeExecutionReceipts() {
  const calls = new Map<number, ExecutionReceipt>();
  const active = new Set<number>();
  let closed = false;
  let outputLost = false;
  let total = 0;
  let completed = 0;
  let unknown = 0;
  const count = (certainty: Certainty, change: number) => {
    if (certainty === "completed") completed += change;
    if (certainty === "unknown") unknown += change;
  };
  return {
    /** Host loss is independent of UI projection and survives bounded row eviction. */
    recordOutputLoss() {
      if (!closed) outputLost = true;
    },
    hasOutputLoss: () => outputLost,
    admit(id: number, tool: string) {
      if (closed || calls.has(id)) return;
      total++;
      if (calls.size >= 256) {
        const settled = [...calls].find(([, call]) => call.delivery !== "pending");
        if (settled) calls.delete(settled[0]);
      }
      if (calls.size < 256)
        calls.set(id, { id, tool: tool.slice(0, 128), certainty: "not-sent", delivery: "pending" });
    },
    start(id: number, tool: string) {
      if (closed) return;
      active.add(id);
      if (calls.has(id)) return;
      // Queued calls own no host operation. Reclaim a queued or settled display slot for
      // each admitted dispatch; only eight runtime calls can hold dispatch slots at once.
      if (calls.size >= 256) {
        const evict = [...calls].find(([key]) => !active.has(key));
        if (evict) calls.delete(evict[0]);
      }
      if (calls.size < 256)
        calls.set(id, { id, tool: tool.slice(0, 128), certainty: "not-sent", delivery: "pending" });
    },
    target(id: number, target: string | undefined) {
      const call = calls.get(id);
      if (!closed && call && target !== undefined)
        calls.set(id, { ...call, target: target.slice(0, 512) });
    },
    observe(id: number | undefined, certainty: Certainty, recoveryId?: string, isError?: boolean) {
      if (closed || id === undefined) return;
      const call = calls.get(id);
      if (!call || call.delivery !== "pending") return;
      count(call.certainty, -1);
      count(certainty, 1);
      const recovery =
        recoveryId !== undefined && RECOVERY_ID.test(recoveryId) ? { recoveryId } : {};
      calls.set(id, { ...call, certainty, ...recovery, ...(isError !== undefined && { isError }) });
    },
    delivery(id: number | undefined, delivered: boolean) {
      if (closed || id === undefined) return;
      active.delete(id);
      const call = calls.get(id);
      if (call) calls.set(id, { ...call, delivery: delivered ? "delivered" : "not-delivered" });
    },
    close(): ExecutionReceipts {
      closed = true;
      active.clear();
      return Object.freeze({
        total,
        completed,
        unknown,
        notSent: total - completed - unknown,
        omitted: total - calls.size,
        calls: Object.freeze(
          [...calls.values()].map((call) =>
            Object.freeze({
              ...call,
              delivery: call.delivery === "pending" ? ("not-delivered" as const) : call.delivery,
            }),
          ),
        ),
      });
    },
  };
}

export const formatExecutionReceipts = (receipts: ExecutionReceipts): string =>
  receipts.total === 0
    ? ""
    : `Nested operation receipts: ${JSON.stringify(receipts)}\nCompleted means adapter settlement, not operation success or background process exit. Inspect affected state or retained provider results; never replay completed or uncertain operations to recover output.`;
