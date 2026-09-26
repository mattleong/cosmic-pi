import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPresentationSettings } from "pi-code-previews/testing";
import { ledgerDetails } from "./support/compact.ts";
import { presentationView, restorePresentationSettings } from "./support/presentation.ts";
import { EMPTY_RECEIPTS } from "./support/results.ts";

afterEach(restorePresentationSettings);
const source = 'const retainedSource = "FULL_PROGRAM_SOURCE";\nthrow new Error(retainedSource);';
const args = { code: source, intent: "Inspect nested operations" };

describe("Code Mode shared presentation conformance", () => {
  it("repaints expanded partial calls and releases their ticker on collapse and settlement", () => {
    let tick: () => void = () => undefined;
    const stop = vi.fn();
    const start = vi.fn((_interval: number, callback: () => void) => {
      tick = callback;
      return stop;
    });
    const invalidate = vi.fn();
    const { view } = presentationView("off", "compact", start);
    const partial = {
      content: [],
      details: {
        toolCalls: [{ id: 1, tool: "pi.read", status: "running" }],
        counts: { total: 1, running: 1, queued: 0, succeeded: 0, failed: 0, cancelled: 0 },
      },
    };
    view.call(args, { expanded: true, isPartial: true, invalidate });
    view.result(partial, { expanded: true, isPartial: true });
    view.render();
    expect(start).toHaveBeenCalledTimes(1);
    tick();
    expect(invalidate).toHaveBeenCalledTimes(1);
    view.call(args, { expanded: false, isPartial: true });
    view.result(partial, { expanded: false, isPartial: true });
    view.render();
    expect(stop).toHaveBeenCalledTimes(1);
    tick();
    expect(invalidate).toHaveBeenCalledTimes(1);
    view.call(args, { expanded: true, isPartial: true });
    view.result(partial, { expanded: true, isPartial: true });
    view.render();
    expect(start).toHaveBeenCalledTimes(2);
    view.result(
      { content: [], details: ledgerDetails([]).details },
      { expanded: true, isPartial: false },
    );
    view.render();
    expect(stop).toHaveBeenCalledTimes(2);
    tick();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it.each(["on", "off", "border"] as const)(
    "keeps retained read identity and origin separate in %s mode",
    (mode) => {
      for (const originalOutcome of ["succeeded", "failed", "cancelled"] as const) {
        const { view } = presentationView(mode, "compact");
        const result = {
          content: [{ type: "text" as const, text: "RETAINED_PAGE" }],
          details: {
            resultRead: {
              status: "page",
              id: "read-1",
              originalOutcome,
              offset: 0,
              end: 4,
              next: 4,
              total: 8,
            },
          },
        };
        view.call({ action: "result.read", id: "read-1" }, { expanded: true });
        view.result(result, { expanded: true });
        const text = view.render().join("\n");
        expect(text).not.toMatch(/Program|Calls|original-execution:|outer-information:/u);
        expect(text.split("RETAINED_PAGE")).toHaveLength(2);
        expect(text).toMatch(/\braw\b/i);
        expect(text.split('Continue with result.read id="read-1" offset=4.')).toHaveLength(2);
        if (originalOutcome !== "succeeded")
          expect(
            text.split(`Original execution ${originalOutcome}; page read succeeded.`),
          ).toHaveLength(2);
      }
      for (const resultRead of [
        undefined,
        { status: "error", code: "unavailable" },
        { status: "page", originalOutcome: "succeeded" },
      ]) {
        const { view } = presentationView(mode, "compact");
        view.call({ action: "result.read", id: "read-1" }, { expanded: true });
        view.result(
          { content: [{ type: "text", text: "UNVERIFIED_PAGE" }], details: { resultRead } },
          { expanded: true },
        );
        const text = view.render().join("\n");
        expect(text).not.toMatch(/Program|Calls|Page read succeeded/u);
        expect(text).toContain("UNVERIFIED_PAGE");
        expect(text).toMatch(/\braw\b/i);
      }
    },
  );
  it.each(["on", "off", "border"] as const)(
    "preserves initial saved-page output and shows paging only on expansion in %s mode",
    (mode) => {
      const { view, execute } = presentationView(mode, "compact");
      const pageText = JSON.stringify({
        id: "cm-current",
        outcome: "succeeded",
        kind: "output",
        offset: 0,
        next: 12,
        total: 100,
        text: "PAGE_OUTPUT_MARKER",
      });
      const result = {
        content: [{ type: "text" as const, text: pageText }],
        details: {
          ...ledgerDetails([]).details,
          truncated: true,
          resultId: "cm-current",
          executionReceipts: EMPTY_RECEIPTS,
          initialPreview: {
            status: "page",
            id: "cm-current",
            originalOutcome: "succeeded",
            kind: "output",
            offset: 0,
            end: 12,
            next: 12,
            total: 100,
            receiptMode: "none",
          },
        },
      };
      const before = JSON.stringify(result);
      for (const expanded of [false, true, false, true]) {
        view.call(args, { expanded });
        view.result(result, { expanded });
        const text = view.render().join("\n");
        expect(text.includes("FULL_PROGRAM_SOURCE")).toBe(expanded);
        expect(text.includes("PAGE_OUTPUT_MARKER")).toBe(expanded);
        expect(text.includes("Continue saved output")).toBe(expanded);
        expect(text).not.toContain("Earlier changes may remain");
      }
      expect(JSON.stringify(result)).toBe(before);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("keeps malformed initial-page history conservative without trusting raw page text", () => {
    const { view } = presentationView("off", "compact");
    const result = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            id: "cm-history",
            outcome: "succeeded",
            next: 10,
            text: "UNTRUSTED_PAGE_MARKER",
          }),
        },
      ],
      details: {
        ...ledgerDetails([]).details,
        truncated: true,
        resultId: "cm-history",
        initialPreview: {
          status: "page",
          id: "wrong-id",
          originalOutcome: "succeeded",
          kind: "output",
          offset: 0,
          end: 10,
          next: 10,
          total: 20,
          receiptMode: "none",
        },
      },
    };
    view.call(args, { expanded: false });
    view.result(result, { expanded: false });
    const collapsed = view.render().join("\n");
    expect(collapsed).toContain("Earlier changes may remain");
    expect(collapsed).not.toContain("UNTRUSTED_PAGE_MARKER");
    view.call(args, { expanded: true });
    view.result(result, { expanded: true });
    const expanded = view.render().join("\n");
    expect(expanded).toContain("UNTRUSTED_PAGE_MARKER");
    expect(expanded).toContain("Output exceeded the output limit");
    expect(expanded).not.toContain("Full output is unavailable");
  });

  it.each(["compact", "preview"] as const)(
    "distinguishes preserved output from formatted results in %s presentation",
    (style) => {
      for (const sample of [
        { text: '{"answer":1}', outputKind: "text", raw: true },
        { text: '{"answer":1}', outputKind: "structured", raw: false },
        { text: '{"answer":', outputKind: "structured", raw: true },
        { text: '{"answer":1,"answer":2}', outputKind: "structured", raw: true },
        { text: '{"answer":1}', outputKind: "structured", truncated: true, raw: true },
      ]) {
        const { view, execute } = presentationView("border", style);
        const result = {
          content: [{ type: "text" as const, text: sample.text }],
          details: {
            ...ledgerDetails([]).details,
            outputKind: sample.outputKind,
            truncated: sample.truncated,
          },
        };
        const before = JSON.stringify(result);
        for (const expanded of [false, true, false, true]) {
          view.call(args, { expanded });
          view.result(result, { expanded });
          const text = view.render().join("\n");
          // Test raw attribution, not the precise heading or card layout.
          expect(/\braw\b/i.test(text), JSON.stringify(sample)).toBe(expanded && sample.raw);
          if (expanded) {
            expect(text).toContain("FULL_PROGRAM_SOURCE");
            expect(text).toContain(
              sample.raw
                ? sample.text
                : JSON.stringify(JSON.parse(sample.text), null, 2).split("\n")[1]!,
            );
          }
        }
        expect(JSON.stringify(result)).toBe(before);
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["on", "off", "border"] as const)(
    "keeps parent and child durations distinct in %s mode",
    (mode) => {
      const { view } = presentationView(mode, "compact");
      applyPresentationSettings({ toolCallTiming: true });
      Object.assign(view.context.state, {
        codePreviewTimingStartedAt: 1000,
        codePreviewTimingEndedAt: 7200,
      });
      const { details } = ledgerDetails([
        { tool: "pi.read", summary: { subject: "file.ts", outcome: "success" } },
      ]);
      const result = {
        content: [{ type: "text" as const, text: "OUTPUT_CONTENT" }],
        details: {
          ...details,
          toolCalls: details.toolCalls.map((call) => ({ ...call, durationMs: 13100 })),
        },
      };
      for (const expanded of [false, true, false, true]) {
        view.call(args, { expanded, isPartial: false });
        view.result(result, { expanded });
        const text = view.render().join("\n");
        expect(text.match(/6\.2s/g)).toHaveLength(1);
        expect(text.match(/13\.1s/g)).toHaveLength(1);
      }
    },
  );

  it.each(["on", "off", "border"] as const)(
    "keeps program source and one failure body in %s mode",
    (mode) => {
      const { view, execute } = presentationView(mode, "compact");
      const details = ledgerDetails([]).details;
      const result = {
        content: [{ type: "text" as const, text: "ROOT_CAUSE\nINDEPENDENT_DIAGNOSTIC" }],
        details,
      };
      const before = JSON.stringify(result);
      for (const expanded of [false, true, false, true]) {
        view.call(args, { expanded, isError: true });
        view.result(result, { expanded, isError: true });
        view.invalidate();
        const text = view.render().join("\n");
        expect(text.includes("FULL_PROGRAM_SOURCE")).toBe(expanded);
        expect(text.split("ROOT_CAUSE")).toHaveLength(expanded ? 2 : 1);
        expect(text.split("INDEPENDENT_DIAGNOSTIC")).toHaveLength(expanded ? 2 : 1);
      }
      expect(JSON.stringify(result)).toBe(before);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["compact", "preview"] as const)(
    "keeps nested recovery and diagnostics in %s presentation",
    (style) => {
      const entries = ["pi.read", "mcp.request", "session.backgroundTask"].map((tool, index) => ({
        tool,
        summary: {
          subject: tool,
          outcome: "warning" as const,
          issues: {
            coverage: "complete" as const,
            entries: [
              {
                operation: "operation",
                code: "retained",
                severity: "warning" as const,
                cause: `CAUSE_${index}`,
                description: `HUMAN_DESCRIPTION_${index}`,
                recovery: [{ code: "inspect", text: `RECOVERY_${index}` }],
                diagnostics: [`DIAGNOSTIC_${index}`],
              },
            ],
          },
        },
      }));
      const result = {
        content: [{ type: "text" as const, text: "RAW_RESULT" }],
        details: ledgerDetails(entries).details,
      };
      const before = JSON.stringify(result);
      const { view, execute } = presentationView("off", style);
      for (const expanded of [false, true, false, true]) {
        view.call(args, { expanded });
        view.result(result, { expanded });
        const text = view.render().join("\n");
        for (const index of [0, 1, 2]) {
          if (style === "compact" && !expanded) {
            expect(text).toContain(`HUMAN_DESCRIPTION_${index}`);
            expect(text).not.toContain(`CAUSE_${index}`);
            expect(text).not.toContain(`RECOVERY_${index}`);
          } else {
            expect(text).toContain(`CAUSE_${index}`);
            expect(text).toContain(`RECOVERY_${index}`);
          }
          if (expanded) {
            expect(text.split(`DIAGNOSTIC_${index}`)).toHaveLength(2);
            expect(text.split(`RECOVERY_${index}`)).toHaveLength(2);
          } else expect(text).not.toContain(`DIAGNOSTIC_${index}`);
        }
        expect(text.includes("RAW_RESULT")).toBe(expanded);
      }
      expect(JSON.stringify(result)).toBe(before);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
