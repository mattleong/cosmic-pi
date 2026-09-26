import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import type { McpCodeModeOutput } from "pi-mcp/code-mode";
import { makeCompactEvidence, type CompactReceipt } from "../src/tools/compact-evidence.ts";
import { ledgerDetails, noReplayNotices, summarize } from "./support/compact.ts";
import { executeHarness } from "./support/execute.ts";
import { renderResultText } from "./support/presentation.ts";
import { mcpProvider } from "./support/providers.ts";

describe("interpreter delivery evidence", () => {
  it.effect(
    "records protocol-valid output rejected at the interpreter depth boundary without changing operation outcome",
    () =>
      Effect.gen(function* () {
        let data: McpCodeModeOutput["data"] = null;
        for (let depth = 0; depth < 40; depth++) data = { child: data };
        const events = mcpProvider(() =>
          Promise.resolve({
            action: "status",
            outcome: "completed",
            isError: false,
            data,
            notices: [],
          }),
        );
        const completed = yield* Effect.promise(() =>
          executeHarness({ events, config: { maxCumulativeChildOutputBytes: 1000000 } }).run(
            'let message=""; try { await tools.mcp.request({action:"status"}); } catch(e) { message=e.message; } return message;',
          ),
        );
        expect(completed.content[0]).toMatchObject({
          text: expect.stringContaining("Invalid output"),
        });
        expect(completed.content[0]).toMatchObject({
          text: expect.stringContaining("Do not replay completed or uncertain operations"),
        });
        const receipt = completed.details!.toolCalls[0]!.compact!;
        expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
        expect(noReplayNotices(receipt.notices)).toHaveLength(1);
        expect(completed.details!.compactAttention).toMatchObject({
          observed: 1,
          errors: 0,
          incomplete: false,
        });
        expect(completed.details!.compactAttention!.notices).toContainEqual(
          noReplayNotices(receipt.notices)[0],
        );
      }),
  );

  it("keeps individual loss explanations on visible children and hidden or evicted calls in the parent", () => {
    const { calls, details } = ledgerDetails(
      Array.from({ length: 36 }, () => ({
        tool: "pi.read",
        summary: { subject: "same file", outcome: "success" },
      })),
      { status: "error", deliveryFailures: 2 },
    );
    const receipts = calls.map((call) => call.compact!);
    expect(details.compactAttention.notices).toHaveLength(32);
    expect(details.compactAttention.incomplete).toBe(true);
    for (const receipt of receipts) expect(noReplayNotices(receipt.notices)).toHaveLength(1);
    const result = { content: [{ type: "text" as const, text: "discarded" }], details };
    const first = noReplayNotices(receipts[0]!.notices)[0]!.text;
    expect(summarize(details)?.issues?.entries.some((issue) => issue.cause === first)).toBe(true);
    const expanded = renderResultText(result, { expanded: true });
    for (const receipt of receipts) {
      expect(expanded.split(noReplayNotices(receipt.notices)[0]!.text)).toHaveLength(2);
    }
  });

  it("preserves existing recovery at receipt and aggregate capacity and marks overflow incomplete", () => {
    let receipt: CompactReceipt | undefined;
    const collector = makeCompactEvidence((_id, value) => {
      receipt = value;
    });
    collector.admit("pi.read");
    collector.start(1, 1);
    const notices = Array.from({ length: 32 }, (_, id) => ({
      kind: "recovery" as const,
      text: `Existing recovery ${id}`,
    }));
    collector.observe(1, () => ({ subject: "file", outcome: "success", notices }));
    collector.deliveryFailure(1);
    collector.deliveryFailure(1);
    expect(receipt).toMatchObject({ deliveryFailed: true, notices });
    expect(collector.snapshot()).toMatchObject({ incomplete: true, notices });
    expect(receipt!.notices).toHaveLength(32);
    collector.end(1);
    collector.close();
  });
});
