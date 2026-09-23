/** Saved receipt facts supplement legacy lifecycle rows, never grant execution authority. */
import type { CompactNotice } from "pi-code-previews";
import type { CompactAttention } from "../tools/compact-evidence.ts";
import type { ExecutionReceipts } from "../tools/execution-receipts.ts";
import type { CodeModeCallEntry } from "../tools/format.ts";

export interface ReceiptAttention {
  readonly outcome: "uncertain" | "warning" | "error";
  readonly notice: CompactNotice;
}

export const replayReceiptAttention = (
  present: boolean,
  receipts: ExecutionReceipts | undefined,
  attention: CompactAttention | undefined,
  toolCalls: readonly CodeModeCallEntry[],
): ReceiptAttention | undefined => {
  if (!present) return undefined;
  const recovery =
    " Inspect operation state or retained results; do not replay completed or uncertain work to recover output.";
  if (receipts === undefined || (receipts.omitted > 0 && attention === undefined))
    return {
      outcome: "uncertain",
      notice: {
        code: "receipt-incomplete",
        kind: "warning",
        text: "Recorded operation evidence is incomplete or inconsistent." + recovery,
        description: "Some operation details cannot be confirmed.",
      },
    };
  if (
    (receipts.unknown > 0 || receipts.calls.some((call) => call.delivery === "pending")) &&
    !attention?.incomplete &&
    !attention?.uncertain
  )
    return {
      outcome: "uncertain",
      notice: {
        code: "receipt-uncertain",
        kind: "warning",
        text: "Some recorded operations have no confirmed outcome." + recovery,
        description: "Some operations may have taken effect without a confirmed result.",
      },
    };
  if (
    (receipts.notSent > 0 || receipts.calls.some((call) => call.isError === true)) &&
    !attention?.errors &&
    !attention?.incomplete
  )
    return {
      outcome: "error",
      notice: {
        code: "receipt-failure",
        kind: "error",
        text: "Recorded operations include failures or calls that were not sent." + recovery,
        description: "Some operations failed or did not run.",
      },
    };
  if (
    receipts.calls.some(
      (call) =>
        call.delivery === "not-delivered" &&
        call.isError !== true &&
        // Delivery loss does not rewrite the operation-outcome counters. A producer's
        // invocation-scoped issue already reports this loss; unrelated issues do not.
        !(
          attention?.version === 2 &&
          attention.issues.entries.some(
            (issue) =>
              issue.operation === `call-${call.id}/delivery` && issue.code === "delivery-failed",
          )
        ) &&
        !toolCalls.some(
          (row) =>
            row.compact?.version === 2 &&
            row.compact.issues.entries.some(
              (issue) =>
                issue.operation === `call-${call.id}/delivery` && issue.code === "delivery-failed",
            ),
        ),
    ) &&
    !attention?.warnings &&
    !attention?.errors &&
    !attention?.uncertain &&
    !attention?.incomplete
  )
    return {
      outcome: "warning",
      notice: {
        code: "receipt-delivery",
        kind: "warning",
        text: "Some recorded operations did not deliver their output to the program." + recovery,
        description: "An operation may have finished without delivering its result.",
      },
    };
  return undefined;
};
