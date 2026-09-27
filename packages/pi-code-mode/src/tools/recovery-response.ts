import type { ExecutionReceipts } from "./execution-receipts.ts";
import { clampModelVisibleText, utf8ByteLength } from "./limits.ts";

const NO_REPLAY =
  "Do not replay completed or uncertain operations to recover output. Inspect affected state or retained provider results.";

interface RecoveryResponse {
  readonly text: string;
  readonly truncated: boolean;
  readonly outputTruncated: boolean;
  /** Where the agent-facing recovery notes begin, after the leading output or diagnostic. */
  readonly notesOffset?: number;
}

const notesAfter = (lead: string, text: string) =>
  lead.length > 0 && text.length > lead.length + 2 && text.startsWith(`${lead}\n\n`)
    ? { notesOffset: lead.length }
    : {};

/** Bounded prose only. Saved artifacts and successful JSON pages retain their own contracts. */
export const composeRecoveryResponse = (input: {
  readonly raw: string;
  readonly recovery: string;
  readonly receipts: ExecutionReceipts;
  readonly nestedOutputLost: boolean;
  readonly maxBytes: number;
}): RecoveryResponse => {
  const { raw, receipts, maxBytes } = input;
  // Risky rows get the available detail space first, without dropping aggregate facts.
  const calls = [...receipts.calls].sort((left, right) => {
    const risk = (call: (typeof receipts.calls)[number]) =>
      call.certainty === "unknown" ? 0 : call.delivery !== "delivered" ? 1 : call.isError ? 2 : 3;
    return risk(left) - risk(right);
  });
  const rows = (count: number) =>
    count === 0
      ? ""
      : `Nested operation receipt rows (${count}/${receipts.calls.length} retained): ${JSON.stringify(calls.slice(0, count))}`;
  const priority = [
    ...(receipts.total > 0 || input.nestedOutputLost ? [NO_REPLAY] : []),
    ...(input.nestedOutputLost
      ? [
          "Warning: nested output or diagnostics were not delivered in full. Retained Code Mode output does not restore discarded child data.",
        ]
      : []),
    ...(receipts.unknown > 0 ? ["Warning: some nested operation outcomes remain unknown."] : []),
    ...(receipts.total > 0
      ? [
          `Nested operation totals: ${JSON.stringify({
            total: receipts.total,
            completed: receipts.completed,
            unknown: receipts.unknown,
            notSent: receipts.notSent,
            omitted: receipts.omitted,
          })}`,
          "Completed means adapter settlement, not operation success, delivered output, or background process exit.",
        ]
      : []),
    input.recovery.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  const join = (parts: readonly string[]) => parts.filter(Boolean).join("\n\n");
  const full = join([raw, priority, rows(calls.length)]);
  if (utf8ByteLength(full) <= maxBytes)
    return { text: full, truncated: false, outputTruncated: false, ...notesAfter(raw, full) };

  const omission = "Some diagnostic text or receipt rows are omitted from this response.";
  const mandatory = join([priority, omission]);
  // Reserve a diagnostic prefix even when the safety block itself exceeds a tiny budget.
  // A small diagnostic gets its full size; a large one cannot consume the recovery block.
  const separator = raw.length > 0 ? 2 : 0;
  const diagnosticReserve = Math.min(utf8ByteLength(raw), Math.floor(maxBytes / 3));
  const boundedPriority = clampModelVisibleText(
    mandatory,
    Math.max(0, maxBytes - diagnosticReserve - separator),
  );
  const boundedRaw = clampModelVisibleText(
    raw,
    Math.max(0, maxBytes - utf8ByteLength(boundedPriority) - separator),
  );
  const base = join([boundedRaw, boundedPriority]);
  const remaining = maxBytes - utf8ByteLength(base) - (base ? 2 : 0);
  let low = 1;
  let high = calls.length;
  let shown = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (utf8ByteLength(rows(middle)) <= remaining) {
      shown = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const text = clampModelVisibleText(join([base, rows(shown)]), maxBytes);
  return {
    text,
    truncated: true,
    outputTruncated: boundedRaw !== raw,
    ...notesAfter(boundedRaw, text),
  };
};
