import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";
import type { ExecutionReceipts } from "../src/tools/execution-receipts.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { codeModeStatusResult } from "../src/tools/status.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { codeModeStatusCompactSummary } from "../src/ui/status.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { withLedger } from "./support/compact.ts";

const receipts: ExecutionReceipts = {
  total: 1,
  completed: 1,
  unknown: 0,
  notSent: 0,
  omitted: 0,
  calls: [
    { id: 0, tool: "pi.write", certainty: "completed", delivery: "delivered", isError: false },
  ],
};

const summarize = (evidence: ExecutionReceipts, receiptMode = "full") =>
  codeModeCompactSummary({
    phase: "settled",
    args: { code: "return payload", intent: "Saved mutation result" },
    result: {
      content: [{ type: "text", text: "saved page" }],
      details: withLedger({
        ...callEntryDetails(
          Array.from({ length: evidence.total }, () => ({
            tool: "pi.write",
            status: "completed" as const,
          })),
        ),
        outputKind: "structured",
        truncated: true,
        resultId: "cm-replay",
        executionReceipts: evidence,
        initialPreview: {
          status: "page",
          id: "cm-replay",
          originalOutcome: "succeeded",
          kind: "output",
          offset: 0,
          end: 1,
          next: 1,
          total: 2,
          receiptMode,
        },
      }),
    },
    context: opaqueFixture({ isError: false, expanded: false }),
  });

const codes = (summary: ReturnType<typeof summarize>) =>
  summary?.issues?.map((issue) => issue.code);

describe("retained output safety evidence", () => {
  it("trusts a saved first page only with consistent operation receipts", () => {
    expect(summarize(receipts)?.outcome).toBe("success");
    expect(codes(summarize(receipts))).toEqual(["saved-output"]);
    for (const [evidence, receiptMode] of [
      [{ ...receipts, completed: 0, unknown: 1 }, "full"],
      [
        { ...receipts, total: 2, completed: 2, calls: [receipts.calls[0]!, receipts.calls[0]!] },
        "full",
      ],
      [receipts, "read-only"],
      [receipts, "none"],
    ] as const) {
      const summary = summarize(evidence, receiptMode);
      // Without a trusted page, truncated output is only known to be incomplete.
      expect(summary?.outcome).toBe("warning");
      expect(codes(summary)).toEqual(["output-truncated"]);
    }
  });

  it("never treats cancelled or truncated status history as successful delivery", () => {
    const result = codeModeStatusResult(DEFAULT_CODE_MODE_CONFIG);
    for (const [flags, expected] of [
      [{ cancelled: true }, "cancelled"],
      [{ truncated: true }, "warning"],
      [{ cancelled: "invalid" }, undefined],
    ] as const) {
      const summary = codeModeStatusCompactSummary({
        phase: "settled",
        args: { action: "status" },
        result: { ...result, details: { ...result.details, ...flags } },
        context: opaqueFixture({ isError: false, expanded: false }),
      });
      expect(summary?.outcome).toBe(expected);
    }
  });
});
