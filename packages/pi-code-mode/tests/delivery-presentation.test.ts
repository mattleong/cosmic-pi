import { afterEach, describe, expect, it } from "vitest";
import { makeExecutionReceipts } from "../src/tools/execution-receipts.ts";
import { composeRecoveryResponse } from "../src/tools/recovery-response.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { deliveryIssues, ledgerDetails } from "./support/compact.ts";
import { presentationView, restorePresentationSettings } from "./support/presentation.ts";

afterEach(restorePresentationSettings);
const args = {
  code: 'try { await tools.pi.read({path:"file",requireComplete:true}); } catch {} return "handled";',
};

const deliveryResult = () => {
  const { details } = ledgerDetails(
    [{ tool: "pi.read", summary: { subject: "file", outcome: "success" } }],
    { status: "error", deliveryFailures: 1 },
  );
  const operations = makeExecutionReceipts();
  operations.admit(1, "pi.read");
  operations.start(1, "pi.read");
  operations.observe(1, "completed", undefined, false);
  operations.delivery(1, false);
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
    details: { ...details, executionReceipts },
  };
};

describe("delivery issue presentation", () => {
  it.each(["on", "off", "border"] as const)(
    "renders one delivery issue on its call in %s mode while preserving the agent safety response",
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
      expect(summary?.outcome).toBe("warning");
      expect(deliveryIssues(summary?.issues)).toEqual([]);
      const child = summary?.children?.entries[0];
      expect(child?.status).toBe("error");
      const [issue] = deliveryIssues(child?.issues);
      expect(deliveryIssues(child?.issues)).toHaveLength(1);
      for (const expanded of [false, true, false, true]) {
        view.call(args, { expanded });
        view.result(result, { expanded });
        const text = view.render().join("\n");
        expect(text.split(issue!.message)).toHaveLength(2);
        expect(text.split(issue!.detail!)).toHaveLength(expanded ? 2 : 1);
        expect(text.includes("AGENT_RESULT_MARKER")).toBe(expanded);
        if (expanded) expect(text).toContain("Do not replay completed or uncertain operations");
      }
      expect(JSON.stringify(result)).toBe(original);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
