import { afterEach, describe, expect, it } from "vitest";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { callEntryDetails, MAX_PROGRESS_ENTRIES } from "../src/tools/format.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { summarize, withLedger } from "./support/compact.ts";
import {
  presentationView,
  renderResultText,
  restorePresentationSettings,
} from "./support/presentation.ts";

afterEach(restorePresentationSettings);

const v2Receipt = {
  version: 2,
  issues: { coverage: "complete", entries: [] },
  subject: "OLD_RECEIPT_SUBJECT",
  outcome: "success",
  deliveryFailed: false,
  notices: [{ kind: "recovery", text: "OLD_RECOVERY_NOTICE" }],
};
const v2Ledger = {
  version: 2,
  issues: { coverage: "complete", entries: [] },
  admitted: 1,
  started: 1,
  observed: 1,
  unsupported: 0,
  errors: 0,
  warnings: 0,
  cancelled: 0,
  uncertain: 0,
  incomplete: false,
  notices: [{ kind: "recovery", text: "OLD_LEDGER_NOTICE" }],
};
const history = <Compact>(compact: Compact) => ({
  ...callEntryDetails([{ tool: "pi.read", status: "completed" }]),
  toolCalls: [{ tool: "pi.read", status: "completed", compact }],
  outputKind: "text",
  compactAttention: v2Ledger,
});
const args = { code: "return 1", intent: "Replayed history" };

describe("replayed history", () => {
  it("falls back to the generic row for old ledgers without decoding their evidence", () => {
    const details = history(v2Receipt);
    const decoded = decodeCodeModeRenderDetails(details);
    expect(decoded.compactAttention).toBeUndefined();
    expect(decoded.toolCalls[0]?.compact).toBeUndefined();
    expect(summarize(details)).toBeUndefined();
    const { view, execute } = presentationView("off", "compact");
    for (const isError of [false, true]) {
      const result = {
        content: [{ type: "text" as const, text: "FIRST_LINE\nSECOND_LINE" }],
        details,
      };
      for (const expanded of [false, true]) {
        view.call(args, { expanded, isError });
        view.result(result, { expanded, isError });
        const text = view.render().join("\n");
        expect(text).toContain("Replayed history");
        expect(text).not.toMatch(/OLD_RECOVERY_NOTICE|OLD_LEDGER_NOTICE|OLD_RECEIPT_SUBJECT/u);
        expect(text.includes("FIRST_LINE")).toBe(expanded || isError);
        expect(text.includes("SECOND_LINE")).toBe(expanded);
      }
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("drops a malformed receipt from its row and marks the current ledger incomplete", () => {
    for (const compact of [v2Receipt, { ...v2Receipt, version: 3, subject: 42 }, null]) {
      const details = withLedger({
        ...callEntryDetails([{ tool: "pi.read", status: "completed" }]),
        toolCalls: [{ tool: "pi.read", status: "completed", compact }],
        outputKind: "text",
      });
      const decoded = decodeCodeModeRenderDetails(details);
      expect(decoded.toolCalls[0]?.compact).toBeUndefined();
      expect(decoded.compactAttention?.incomplete).toBe(true);
      const summary = summarize(details);
      expect(summary?.children?.entries[0]?.status).toBe("returned");
      expect(summary?.outcome).toBe("warning");
      expect(summary?.issues?.map((issue) => issue.code)).toEqual(["incomplete"]);
    }
  });

  it("redacts legacy activity before bounding its display", () => {
    const details = decodeCodeModeRenderDetails({
      toolCalls: [
        {
          tool: "pi.bash",
          status: "completed",
          activity: `token=${"private".repeat(400)}`,
        },
      ],
    });
    expect(details.toolCalls[0]?.activity).not.toContain("private");
  });

  it("renders unknown history and hostile themes without throwing or losing raw output", () => {
    const details = withLedger({ ...history(undefined), outputKind: "unknown" });
    expect(summarize(details)).toBeUndefined();
    const hostile = opaqueFixture({
      fg: () => {
        throw new Error("theme unavailable");
      },
    });
    for (const expanded of [false, true]) {
      for (const theme of [plainTheme, hostile]) {
        const rendered = renderResultText(
          { details, content: [{ type: "text", text: "RAW_OUTPUT" }] },
          { expanded, theme },
        );
        expect(rendered.includes("RAW_OUTPUT")).toBe(expanded);
      }
    }
  });

  it("bounds rows and ignores hostile row entries", () => {
    const details = decodeCodeModeRenderDetails({
      toolCalls: Array.from({ length: MAX_PROGRESS_ENTRIES + 1 }, () => ({
        status: "unknown",
        compact: { ...v2Receipt, version: 3 },
      })),
      compactAttention: { ...v2Ledger, version: 3 },
    });
    expect(details.toolCalls).toEqual([]);
    expect(details.compactEligible).toBe(false);
    expect(details.compactAttention?.incomplete).toBe(true);
  });
});
