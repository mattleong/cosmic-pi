/** Operation facts, separate from UI severity and from guest delivery. No inputs or errors. */
export type Certainty = "not-sent" | "completed" | "unknown";
export interface ExecutionReceipt {
  readonly id: number;
  readonly tool: string;
  readonly target?: string;
  readonly certainty: Certainty;
  readonly delivery: "pending" | "delivered" | "not-delivered";
  readonly recoveryId?: string;
  readonly isError?: boolean;
}
export interface ExecutionReceipts {
  readonly total: number;
  readonly completed: number;
  readonly unknown: number;
  readonly notSent: number;
  readonly omitted: number;
  readonly calls: ReadonlyArray<ExecutionReceipt>;
}
export function makeExecutionReceipts() {
  const calls = new Map<number, ExecutionReceipt>();
  const active = new Set<number>();
  let closed = false;
  let total = 0;
  let completed = 0;
  let unknown = 0;
  const count = (certainty: Certainty, change: number) => {
    if (certainty === "completed") completed += change;
    if (certainty === "unknown") unknown += change;
  };
  return {
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
        recoveryId !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(recoveryId)
          ? { recoveryId }
          : {};
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
