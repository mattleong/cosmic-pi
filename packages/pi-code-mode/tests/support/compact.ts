import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { makeCompactEvidence, type CompactAttention } from "../../src/tools/compact-evidence.ts";
import {
  callEntryDetails,
  type CodeModeCallCounts,
  type CodeModeCallEntry,
} from "../../src/tools/format.ts";
import { codeModeCompactSummary } from "../../src/ui/compact-summary.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";

/** A complete current (v3) ledger with no attention. */
export const COMPLETE_LEDGER: CompactAttention = {
  version: 3,
  errors: 0,
  warnings: 0,
  cancelled: 0,
  uncertain: 0,
  incomplete: false,
};

/** Details as the current producer emits them: lifecycle rows plus a v3 ledger. */
export const withLedger = <Details extends object>(
  details: Details,
  ledger: Partial<CompactAttention> = {},
) => ({ ...details, compactAttention: { ...COMPLETE_LEDGER, ...ledger } });

/**
 * Settle each entry through the real compact ledger with ids 1..n, then close it. Rows keep every
 * published receipt; `details` bounds them exactly as execution does.
 */
export const ledgerDetails = (
  entries: readonly { tool: string; summary: CompactSummary }[],
  options: {
    status?: CodeModeCallEntry["status"];
    deliveryFailures?: number;
    counts?: CodeModeCallCounts;
  } = {},
) => {
  const calls: CodeModeCallEntry[] = entries.map((entry) => ({
    tool: entry.tool,
    status: options.status ?? "completed",
  }));
  const ledger = makeCompactEvidence((id, compact) => {
    calls[id - 1] = { ...calls[id - 1]!, compact };
  });
  for (const [index, entry] of entries.entries()) {
    const id = index + 1;
    ledger.start(id, id);
    ledger.observe(id, () => entry.summary);
    for (let count = 0; count < (options.deliveryFailures ?? 0); count++)
      ledger.deliveryFailure(id);
    ledger.end(id);
  }
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

/** The no-replay issue recorded when a settled result never reached the program. */
export const deliveryIssues = (issues: readonly CompactIssue[] | undefined = []) =>
  issues.filter((issue) => issue.code === "delivery-failed");
