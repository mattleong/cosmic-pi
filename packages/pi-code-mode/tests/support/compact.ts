import type { CompactSummary } from "pi-code-previews";
import { makeCompactEvidence } from "../../src/tools/compact-evidence.ts";
import {
  callEntryDetails,
  type CodeModeCallCounts,
  type CodeModeCallEntry,
} from "../../src/tools/format.ts";
import { codeModeCompactSummary } from "../../src/ui/compact-summary.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";

/**
 * Settle each entry through the real compact ledger with ids 1..n, then close it. Rows keep every
 * published receipt; `details` bounds them exactly as execution does.
 */
export const ledgerDetails = (
  entries: readonly { tool: string; summary: CompactSummary }[],
  options: {
    status?: CodeModeCallEntry["status"];
    deliveryFailures?: number;
    unstarted?: readonly string[];
    counts?: CodeModeCallCounts;
  } = {},
) => {
  const calls: CodeModeCallEntry[] = [];
  const ledger = makeCompactEvidence((id, compact) => {
    calls[id - 1] = { tool: entries[id - 1]!.tool, status: options.status ?? "completed", compact };
  });
  for (const [index, entry] of entries.entries()) {
    const id = index + 1;
    ledger.admit(entry.tool);
    ledger.start(id, id);
    ledger.observe(id, () => entry.summary);
    for (let count = 0; count < (options.deliveryFailures ?? 0); count++)
      ledger.deliveryFailure(id);
    ledger.end(id);
  }
  for (const tool of options.unstarted ?? []) ledger.admit(tool);
  ledger.close();
  return {
    calls,
    details: {
      ...callEntryDetails(calls, options.counts),
      compactAttention: ledger.snapshot(),
      outputKind: "text" as const,
    },
  };
};

export const summarize = <Details>(
  details: Details,
  options: {
    phase?: "pending" | "running" | "settled";
    isError?: boolean;
    text?: string;
    expanded?: boolean;
  } = {},
) =>
  codeModeCompactSummary({
    phase: options.phase ?? "settled",
    args: { code: "SECRET SOURCE", intent: "Inspect the project" },
    result: { details, content: [{ type: "text", text: options.text ?? "ordinary output" }] },
    context: opaqueFixture({
      isError: options.isError ?? false,
      expanded: options.expanded ?? false,
    }),
  });

/** Delivery-loss recovery that tells the agent not to replay a completed call. */
export const noReplayNotices = (notices: readonly { readonly text: string }[] = []) =>
  notices.filter((notice) => notice.text.includes("do not replay"));
