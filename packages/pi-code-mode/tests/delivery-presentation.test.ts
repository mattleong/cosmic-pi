import { afterEach, describe, expect, it } from "vitest";
import { summaryCompactIssues } from "pi-code-previews";
import { makeExecutionReceipts } from "../src/tools/execution-receipts.ts";
import { composeRecoveryResponse } from "../src/tools/recovery-response.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { ledgerDetails } from "./support/compact.ts";
import { presentationView, restorePresentationSettings } from "./support/presentation.ts";

afterEach(restorePresentationSettings);
const args = {
  code: 'try { await tools.pi.read({path:"file",requireComplete:true}); } catch {} return "handled";',
};

const deliveryResult = (receiptId = 1, childOnly = false) => {
  const { details } = ledgerDetails(
    [
      {
        tool: "pi.read",
        summary: {
          subject: "file",
          outcome: "success",
          issues: { coverage: "complete", entries: [] },
        },
      },
    ],
    { status: "error", deliveryFailures: 1 },
  );
  const attention = details.compactAttention;
  const compactAttention = childOnly
    ? { ...attention, issues: { coverage: "complete" as const, entries: [] } }
    : attention;
  const operations = makeExecutionReceipts();
  operations.admit(receiptId, "pi.read");
  operations.start(receiptId, "pi.read");
  operations.observe(receiptId, "completed", undefined, false);
  operations.delivery(receiptId, false);
  const executionReceipts = operations.close();
  return {
    content: [
      {
        type: "text" as const,
        text: composeRecoveryResponse({
          raw: "AGENT_RESULT_MARKER",
          recovery: "",
          receipts: executionReceipts,
          nestedOutputLost: true,
          maxBytes: 51_200,
        }).text,
      },
    ],
    details: { ...details, compactAttention, executionReceipts },
  };
};

describe("delivery warning ownership", () => {
  it.each(["on", "off", "border"] as const)(
    "renders one delivery issue in %s mode while preserving the agent safety response",
    (mode) => {
      const { owned, execute, view } = presentationView(mode, "compact");
      const result = deliveryResult();
      const original = JSON.stringify(result);
      const summary = owned.compactSummary({
        phase: "settled",
        args,
        result,
        context: opaqueFixture({ isError: false }),
      });
      const deliveryIssues = summary?.issues?.entries.filter((issue) =>
        ["delivery-failed", "receipt-delivery"].includes(issue.code),
      );
      expect(deliveryIssues).toHaveLength(1);
      expect(deliveryIssues?.[0]?.code).toBe("delivery-failed");
      expect(summary?.outcome).toBe("warning");
      const issue = deliveryIssues![0]!;
      for (const expanded of [false, true, false, true]) {
        view.call(args, { expanded });
        view.result(result, { expanded });
        const text = view.render().join("\n");
        if (expanded) {
          expect(text).toContain("AGENT_RESULT_MARKER");
          expect(text).toContain("Do not replay completed or uncertain operations");
          expect(text.split(issue.cause)).toHaveLength(2);
        } else {
          expect(text.split(issue.description!)).toHaveLength(2);
          expect(text).not.toContain("AGENT_RESULT_MARKER");
        }
      }
      expect(JSON.stringify(result)).toBe(original);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["on", "off", "border"] as const)(
    "uses a retained child delivery issue when the parent ledger lacks it in %s mode",
    (mode) => {
      const { owned, view } = presentationView(mode, "compact");
      const result = deliveryResult(1, true);
      const summary = owned.compactSummary({
        phase: "settled",
        args,
        result,
        context: opaqueFixture({ isError: false }),
      });
      expect(
        summary &&
          summaryCompactIssues(summary).entries.filter((issue) =>
            ["delivery-failed", "receipt-delivery"].includes(issue.code),
          ),
      ).toHaveLength(1);
      for (const expanded of [false, true]) {
        view.call(args, { expanded });
        view.result(result, { expanded });
        const text = view.render().join("\n");
        expect(text).not.toContain("Some recorded operations did not deliver their output");
        expect(text).toContain(
          expanded
            ? "did not deliver its result to the program"
            : "An operation may have finished, but its result did not reach the program.",
        );
      }
    },
  );

  it("keeps the receipt fallback when the existing warning belongs to another invocation", () => {
    const { owned } = presentationView("off", "compact");
    const summary = owned.compactSummary({
      phase: "settled",
      args,
      result: deliveryResult(2),
      context: opaqueFixture({ isError: false }),
    });
    expect(summary?.issues?.entries.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["delivery-failed", "receipt-delivery"]),
    );
  });
});
