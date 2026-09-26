/** Pure progress/count transitions shared by one execution. */
import type * as Types from "effect/Types";
import type { CodeModeCallCounts, CodeModeCallEntry } from "./format.ts";

export type MutableCallCounts = Types.Mutable<CodeModeCallCounts>;
export type MutableCallEntry = Types.Mutable<CodeModeCallEntry>;

export const snapshotCalls = (
  calls: ReadonlyMap<number, MutableCallEntry>,
): ReadonlyArray<CodeModeCallEntry> => Array.from(calls.values(), (call) => ({ ...call }));

export const emptyCounts = (): MutableCallCounts => ({
  total: 0,
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
});

export const statusCountKey = (
  status: CodeModeCallEntry["status"],
): Exclude<keyof CodeModeCallCounts, "total"> =>
  status === "completed" ? "succeeded" : status === "error" ? "failed" : status;

export const transitionCall = (
  call: MutableCallEntry,
  status: CodeModeCallEntry["status"],
  counts: MutableCallCounts,
): void => {
  if (call.status === status) return;
  counts[statusCountKey(call.status)] -= 1;
  counts[statusCountKey(status)] += 1;
  call.status = status;
};

export const settlePendingAsCancelled = (
  calls: ReadonlyMap<number, MutableCallEntry>,
  counts: MutableCallCounts,
): boolean => {
  let changed = false;
  for (const call of calls.values()) {
    if (call.status === "queued" || call.status === "running") {
      transitionCall(call, "cancelled", counts);
      changed = true;
    }
  }
  return changed;
};
