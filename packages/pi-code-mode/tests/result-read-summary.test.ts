import { afterEach, describe, expect, it } from "vitest";
import { resultReadCompactSummary } from "../src/ui/result-read-summary.ts";
import { resultReadFailure } from "../src/results/read-presentation.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { presentationView, restorePresentationSettings } from "./support/presentation.ts";
import { EMPTY_RECEIPTS } from "./support/results.ts";

afterEach(restorePresentationSettings);

const page = {
  status: "page",
  id: "retained-1",
  originalOutcome: "succeeded",
  offset: 10,
  end: 20,
  next: 20,
  total: 30,
};
const summary = <ResultRead>(resultRead: ResultRead) =>
  resultReadCompactSummary({ resultRead }, "retained-1");

describe("retained-read summaries", () => {
  it("separates successful page reads from failed or cancelled original execution", () => {
    for (const originalOutcome of ["succeeded", "failed", "cancelled"]) {
      const projected = summary({ ...page, originalOutcome });
      expect(projected?.outcome).toBe(originalOutcome === "succeeded" ? "success" : "warning");
      expect(projected?.counters?.join(" ")).toMatch(/\b10\b.*\b20\b.*\b30\b/u);
      // Paging is informational: its continuation is expanded-only detail.
      expect(projected?.issues).toContainEqual(
        expect.objectContaining({ severity: "info", detail: expect.stringContaining("offset=20") }),
      );
      expect(projected?.issues?.filter((issue) => issue.severity === "warning")).toHaveLength(
        originalOutcome === "succeeded" ? 0 : 1,
      );
    }
    const eof = summary({ ...page, end: 30, next: null });
    expect(eof?.outcome).toBe("success");
    expect(eof?.issues).toEqual([]);
    expect(summary({ ...page, offset: 0, end: 0, total: 0, next: null })?.outcome).toBe("success");
  });

  it("keeps short owned read failures even when model-visible text is clamped away", () => {
    for (const code of [
      "invalid-input",
      "unavailable",
      "invalid-offset",
      "page-budget",
      "revoked",
    ] as const) {
      const failure = resultReadFailure(code, 0);
      expect(failure.text).toBe("");
      const projected = summary(failure.presentation);
      expect(projected?.outcome).toBe("error");
      expect(projected?.issues).toHaveLength(1);
      expect(projected?.issues?.[0]).toMatchObject({ severity: "error", code });
      expect(projected?.issues?.[0]?.message.length).toBeGreaterThan(0);
      expect(projected?.issues?.[0]?.detail?.length).toBeGreaterThan(0);
    }
  });

  it("retains page coordinates at narrow widths and reserves routine instructions for expansion", () => {
    const id = "cm--88ju67vnzx--1zwbiguwetb-1";
    for (const next of [20, null]) {
      const details = {
        resultRead: {
          ...page,
          id,
          originalOutcome: "failed",
          total: next === null ? 20 : 30,
          next,
        },
      };
      const projected = resultReadCompactSummary(details, id)!;
      const { view } = presentationView("off", "compact");
      const render = (expanded: boolean, width: number) => {
        view.call({ action: "result.read", id }, { expanded });
        view.result({ content: [{ type: "text", text: "PAGE" }], details }, { expanded });
        return view.render(width).join("\n");
      };
      for (const width of [60, 80]) {
        const collapsed = render(false, width);
        expect(collapsed).toContain(projected.counters![0]);
        for (const issue of projected.issues!) {
          expect(collapsed.includes(issue.message)).toBe(issue.severity !== "info");
          expect(collapsed).not.toContain(issue.detail);
        }
      }
      const expanded = render(true, 300);
      for (const issue of projected.issues!) {
        expect(expanded.split(issue.message)).toHaveLength(2);
        expect(expanded.split(issue.detail!)).toHaveLength(2);
      }
    }
  });

  it("declines malformed, mismatched, nonadvancing and missing page evidence", () => {
    for (const invalid of [
      undefined,
      {},
      { status: "error", code: "unknown" },
      { ...page, id: "different" },
      { ...page, originalOutcome: "unknown" },
      { ...page, offset: -1 },
      { ...page, end: 9 },
      { ...page, end: 31 },
      { ...page, next: 15 },
      { ...page, end: 10, next: 10 },
      { ...page, next: null },
      { ...page, next: 30 },
      { ...page, total: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(summary(invalid)).toBeUndefined();
  });

  it("keeps historical extra fields while enforcing bounded page metadata", () => {
    const id = "r".repeat(128);
    const valid = resultReadCompactSummary(
      {
        resultRead: {
          ...page,
          id,
          offset: Number.MAX_SAFE_INTEGER,
          end: Number.MAX_SAFE_INTEGER,
          total: Number.MAX_SAFE_INTEGER,
          next: null,
          historicalField: true,
        },
        historicalField: true,
      },
      id,
    );
    expect(valid?.outcome).toBe("success");
    expect(summary({ status: "error", code: "revoked", historicalField: true })?.outcome).toBe(
      "error",
    );
    for (const invalid of [
      { ...page, id: "r".repeat(129) },
      { ...page, id: "" },
      { ...page, offset: 10.5 },
      { ...page, offset: Number.MAX_SAFE_INTEGER + 1 },
      { ...page, end: Number.POSITIVE_INFINITY },
      { ...page, next: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(resultReadCompactSummary({ resultRead: invalid }, invalid.id)).toBeUndefined();
    }
  });

  it("validates first-page metadata independently of saved-read metadata", () => {
    const id = "p".repeat(128);
    const initialPreview = {
      status: "page",
      id,
      originalOutcome: "succeeded",
      kind: "output",
      offset: 0,
      end: 3,
      next: 3,
      total: 5,
      receiptMode: "none",
      historicalField: true,
    };
    const details = {
      ...callEntryDetails([]),
      outputKind: "text",
      truncated: true,
      resultId: id,
      executionReceipts: EMPTY_RECEIPTS,
      initialPreview,
    };
    expect(decodeCodeModeRenderDetails(details).initialPreview).toMatchObject({
      status: "page",
      id,
      end: 3,
      next: 3,
      receiptMode: "none",
    });
    for (const invalid of [
      { ...initialPreview, id: "p".repeat(129) },
      { ...initialPreview, kind: "failure-receipt" },
      { ...initialPreview, originalOutcome: "failed" },
      { ...initialPreview, receiptMode: "unknown" },
      { ...initialPreview, end: 3.5 },
      { ...initialPreview, total: Number.MAX_SAFE_INTEGER + 1 },
      { ...initialPreview, next: 4 },
      { ...initialPreview, id: "different" },
    ]) {
      expect(
        decodeCodeModeRenderDetails({ ...details, initialPreview: invalid }).initialPreview,
      ).toBeUndefined();
    }
    expect(
      decodeCodeModeRenderDetails({ ...details, truncated: false }).initialPreview,
    ).toBeUndefined();
  });

  it("does not interpret returned text as read or execution evidence", () => {
    expect(resultReadCompactSummary({ text: JSON.stringify(page) }, "retained-1")).toBeUndefined();
    expect(
      resultReadCompactSummary({ resultRead: page, text: "execution failed" }, "retained-1")
        ?.outcome,
    ).toBe("success");
  });
});
