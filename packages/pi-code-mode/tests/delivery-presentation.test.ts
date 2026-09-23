import { afterEach, describe, expect, it, vi } from "vitest";
import { summaryCompactIssues, withCodePreviewShell } from "pi-code-previews";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { makeCompactEvidence, type CompactReceipt } from "../src/tools/compact-evidence.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { makeExecutionReceipts } from "../src/tools/execution-receipts.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { composeRecoveryResponse } from "../src/tools/recovery-response.ts";
import { opaqueHostFixture } from "./support/host.ts";

const initial = codePreviewSettings;
afterEach(() => setCodePreviewSettings(initial));
const theme = opaqueHostFixture({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});
const args = {
  code: 'try { await tools.pi.read({path:"file",requireComplete:true}); } catch {} return "handled";',
};

const deliveryResult = (receiptId = 1, childOnly = false) => {
  let compact: CompactReceipt | undefined;
  const evidence = makeCompactEvidence((_id, receipt) => {
    compact = receipt;
  });
  evidence.admit("pi.read");
  evidence.start(1, 1);
  evidence.observe(1, () => ({
    subject: "file",
    outcome: "success",
    issues: { coverage: "complete", entries: [] },
  }));
  evidence.deliveryFailure(1);
  evidence.end(1);
  evidence.close();
  const attention = evidence.snapshot();
  const compactAttention =
    childOnly && attention.version === 2
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
    details: {
      ...callEntryDetails([{ tool: "pi.read", status: "error", ...(compact && { compact }) }]),
      compactAttention,
      executionReceipts,
      outputKind: "text" as const,
    },
  };
};

const create = (mode: "on" | "off" | "border") => {
  setCodePreviewSettings({ ...initial, toolCallCollapsedStyle: "compact", toolCallTiming: false });
  const execute = vi.fn(() => Promise.reject(new Error("Rendering must not execute")));
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute,
  });
  const tool = withCodePreviewShell(owned, {
    mode,
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
  return { owned, execute, view: createToolPresentationHarness(tool, { theme, width: 500 }) };
};

describe("delivery warning ownership", () => {
  it.each(["on", "off", "border"] as const)(
    "renders one delivery issue in %s mode while preserving the agent safety response",
    (mode) => {
      const { owned, execute, view } = create(mode);
      const result = deliveryResult();
      const original = JSON.stringify(result);
      const summary = owned.compactSummary({
        phase: "settled",
        args,
        result,
        context: opaqueHostFixture({ isError: false }),
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
      const { owned, view } = create(mode);
      const result = deliveryResult(1, true);
      const summary = owned.compactSummary({
        phase: "settled",
        args,
        result,
        context: opaqueHostFixture({ isError: false }),
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
    const { owned } = create("off");
    const summary = owned.compactSummary({
      phase: "settled",
      args,
      result: deliveryResult(2),
      context: opaqueHostFixture({ isError: false }),
    });
    expect(summary?.issues?.entries.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["delivery-failed", "receipt-delivery"]),
    );
  });
});
