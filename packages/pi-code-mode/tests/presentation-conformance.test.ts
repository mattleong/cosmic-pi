import { afterEach, describe, expect, it, vi } from "vitest";
import { withCodePreviewShell, type CompactSummary } from "pi-code-previews";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { makeCompactEvidence } from "../src/tools/compact-evidence.ts";
import type { CodeModeCallEntry } from "../src/tools/format.ts";
import { opaqueHostFixture } from "./support/host.ts";

const initial = codePreviewSettings;
afterEach(() => setCodePreviewSettings(initial));
const theme = opaqueHostFixture({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});
const source = 'const retainedSource = "FULL_PROGRAM_SOURCE";\nthrow new Error(retainedSource);';
const args = { code: source, intent: "Inspect nested operations" };

const create = (
  mode: "on" | "off" | "border",
  style: "compact" | "preview",
  startUiTicker: NonNullable<
    Parameters<typeof buildCodeModeToolDefinition>[0]["startUiTicker"]
  > = () => () => undefined,
) => {
  setCodePreviewSettings({ ...initial, toolCallCollapsedStyle: style, toolCallTiming: false });
  const execute = vi.fn(() => Promise.reject(new Error("Rendering must not execute")));
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute,
    startUiTicker,
  });
  const tool = withCodePreviewShell(owned, {
    mode,
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
  return { view: createToolPresentationHarness(tool, { theme, width: 500 }), execute };
};

const nestedDetails = (entries: readonly { tool: string; summary: CompactSummary }[]) => {
  const calls: CodeModeCallEntry[] = [];
  const ledger = makeCompactEvidence((id, compact) => {
    calls.push({ tool: entries[id - 1]!.tool, status: "completed", compact });
  });
  for (const [index, entry] of entries.entries()) {
    const id = index + 1;
    ledger.admit(entry.tool);
    ledger.start(id, id);
    ledger.observe(id, () => entry.summary);
    ledger.end(id);
  }
  ledger.close();
  return {
    toolCalls: calls,
    counts: {
      total: calls.length,
      succeeded: calls.length,
      failed: 0,
      cancelled: 0,
      running: 0,
      queued: 0,
    },
    compactAttention: ledger.snapshot(),
    outputKind: "text" as const,
  };
};

describe("Code Mode shared presentation conformance", () => {
  it("repaints expanded partial calls and releases their ticker on collapse and settlement", () => {
    let tick: () => void = () => undefined;
    const stop = vi.fn();
    const start = vi.fn((_interval: number, callback: () => void) => {
      tick = callback;
      return stop;
    });
    const invalidate = vi.fn();
    const { view } = create("off", "compact", start);
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
    view.result({ content: [], details: nestedDetails([]) }, { expanded: true, isPartial: false });
    view.render();
    expect(stop).toHaveBeenCalledTimes(2);
    tick();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it.each(["on", "off", "border"] as const)(
    "keeps retained read identity and origin separate in %s mode",
    (mode) => {
      for (const originalOutcome of ["succeeded", "failed", "cancelled"] as const) {
        const { view } = create(mode, "compact");
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
        const { view } = create(mode, "compact");
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
        const { view, execute } = create("border", style);
        const result = {
          content: [{ type: "text" as const, text: sample.text }],
          details: {
            ...nestedDetails([]),
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
      const { view } = create(mode, "compact");
      setCodePreviewSettings({ ...codePreviewSettings, toolCallTiming: true });
      Object.assign(view.context.state, {
        codePreviewTimingStartedAt: 1000,
        codePreviewTimingEndedAt: 7200,
      });
      const details = nestedDetails([
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
      const { view, execute } = create(mode, "compact");
      const details = nestedDetails([]);
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
        details: nestedDetails(entries),
      };
      const before = JSON.stringify(result);
      const { view, execute } = create("off", style);
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
