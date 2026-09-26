import * as codePreviews from "pi-code-previews";
import { applyPresentationSettings, renderContextFixture } from "pi-code-previews/testing";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { renderCodeModeToolResult } from "../src/ui/tool-renderer.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { ledgerDetails, withLedger } from "./support/compact.ts";
import {
  applyCollapsedStyle,
  presentationView,
  restorePresentationSettings,
} from "./support/presentation.ts";

type StartUiTicker = (intervalMs: number, tick: () => void) => () => void;
const definition = (startUiTicker: StartUiTicker = () => () => undefined) =>
  buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute: () => Promise.reject(new Error("not executed")),
    startUiTicker,
  });
const result = (status: "running" | "completed" = "completed") => ({
  content: [{ type: "text" as const, text: "safe output" }],
  details: {
    toolCalls: [{ tool: "pi.read", status }],
    counts: {
      total: 1,
      queued: 0,
      running: status === "running" ? 1 : 0,
      succeeded: status === "completed" ? 1 : 0,
      failed: 0,
      cancelled: 0,
    },
  },
});

afterEach(restorePresentationSettings);

describe("code mode render detail normalization", () => {
  it("repairs contradictory exact counts without understating valid visible rows", () => {
    const details = decodeCodeModeRenderDetails({
      toolCalls: [
        { tool: "pi.read", status: "completed" },
        { tool: "pi.grep", status: "running" },
      ],
      counts: {
        total: 1,
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 3,
        cancelled: 0,
      },
    });
    expect(details.counts).toEqual({
      total: 5,
      queued: 0,
      running: 1,
      succeeded: 1,
      failed: 3,
      cancelled: 0,
    });
  });

  it("ignores malformed rows and counts only visible rows without exact counts", () => {
    const toolCalls = [
      { tool: "pi.read", status: "completed" },
      null,
      { tool: "pi.write" },
      { tool: "pi.grep", status: "unknown" },
    ];
    const details = decodeCodeModeRenderDetails({ toolCalls, totalToolCalls: 4 });
    expect(details.toolCalls).toHaveLength(1);
    expect(details.counts).toMatchObject({ total: 1, succeeded: 1 });
  });
});

describe("registered code mode renderers", () => {
  it("contains hostile render getters and stops stale animation", () => {
    const stop = vi.fn();
    const state = { piCodeModeProgressTicker: stop, piCodeModeProgressInvalidate: vi.fn() };
    const options = {
      expanded: false,
      get isPartial(): boolean {
        throw new Error("hostile isPartial getter");
      },
    };
    const hostileResult = {
      content: [{ type: "text" as const, text: "safe output" }],
      get details(): never {
        throw new Error("hostile details getter");
      },
    };
    const context = {
      state,
      invalidate: vi.fn(),
      get isError(): boolean {
        throw new Error("hostile isError getter");
      },
      get expanded(): boolean {
        throw new Error("hostile expanded getter");
      },
    };
    expect(() =>
      definition().renderResult?.(
        opaqueFixture(hostileResult),
        options,
        plainTheme,
        opaqueFixture(context),
      ),
    ).not.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["normal", "throwing-call", "missing", "throwing-getter"] as const)(
    "starts and settles an owned ticker exactly once with %s invalidation",
    (kind) => {
      const stop = vi.fn();
      let tick: (() => void) | undefined;
      const start = vi.fn((_interval: number, callback: () => void) => {
        tick = callback;
        return stop;
      });
      const tool = definition(start);
      const render = <Context extends object>(status: "running" | "completed", context: Context) =>
        tool.renderResult?.(
          result(status),
          { isPartial: status === "running", expanded: false },
          plainTheme,
          opaqueFixture(context),
        );
      const state = {};
      const invalidate = vi.fn(() => {
        if (kind === "throwing-call") throw new Error("hostile invalidation");
      });
      const running = { expanded: false, isError: false, state, invalidate };
      const settled =
        kind === "missing"
          ? { state }
          : kind === "throwing-getter"
            ? {
                state,
                get invalidate(): never {
                  throw new Error("hostile invalidate getter");
                },
              }
            : running;
      for (let index = 0; index < 2; index += 1) render("running", running);
      expect(start).toHaveBeenCalledOnce();
      expect(() => tick?.()).not.toThrow();
      expect(invalidate).toHaveBeenCalledOnce();

      for (let index = 0; index < 2; index += 1) {
        expect(() => render("completed", settled)).not.toThrow();
        expect(stop).toHaveBeenCalledOnce();
        expect(state).toHaveProperty("piCodeModeProgressTicker", undefined);
        expect(state).toHaveProperty("piCodeModeProgressInvalidate", undefined);
      }
    },
  );

  it("keeps registered output terminal-safe under hostile content and keybindings", () => {
    const getKeys = vi.fn(() => ["ctrl+o", "\u001b[2Jhostile", "x".repeat(100)]);
    setKeybindings(opaqueFixture({ getKeys }));
    const tool = definition();
    const context = renderContextFixture({ isPartial: false, invalidate: vi.fn() });
    const collapsed = tool.renderResult?.(
      opaqueFixture({
        content: [{ type: "text", text: "safe\u001b[2J output" }],
        details: {},
      }),
      { isPartial: false, expanded: false },
      plainTheme,
      context,
    );
    tool.renderResult?.(result(), { isPartial: false, expanded: false }, plainTheme, context);
    expect(collapsed?.render(80).join("\n")).not.toContain("\u001b");

    expect(() =>
      tool.renderCall?.(
        { intent: "inspect\u001b]0;title\u0007", code: "return '\u001b[2J';" },
        plainTheme,
        opaqueFixture({
          get expanded(): boolean {
            throw new Error("hostile expanded");
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("collapsed call trees", () => {
  it.each(["compact", "preview"] as const)(
    "caps only the compact tree and stays within width in %s style",
    (style) => {
      const { details } = ledgerDetails(
        Array.from({ length: 8 }, (_, id) => ({
          tool: "pi.read",
          summary: { subject: `file-${id}`, outcome: "success" as const },
        })),
      );
      const { view, execute } = presentationView("off", style);
      const args = { code: "return 'SOURCE_MARKER';", intent: "Inspect files" };
      view.call(args, { expanded: false });
      view.result(
        { content: [{ type: "text", text: "OUTPUT_MARKER" }], details },
        { expanded: false },
      );
      const text = view.render(120).join("\n");
      const shown = Array.from({ length: 8 }, (_, id) => text.includes(`file-${id}`));
      expect(shown.filter(Boolean)).toHaveLength(style === "preview" ? 8 : 5);
      expect(text).toContain("Inspect files");
      expect(text).not.toMatch(/SOURCE_MARKER|OUTPUT_MARKER/u);
      for (const width of [6, 24, 60])
        expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});

describe("expanded retained presentation", () => {
  it.each(["off", "on", "border"] as const)(
    "renders one expanded source/header in %s mode and keeps every bounded child before the result",
    (mode) => {
      applyCollapsedStyle("compact");
      const owned = definition();
      const tool = codePreviews.withCodePreviewShell(owned, {
        mode,
        compactSummary: owned.compactSummary,
        expandedContent: owned.expandedContent,
      });
      const args = {
        code: "const marker = 1; return {answer: marker};",
        intent: "Inspect retained calls",
      };
      const context = renderContextFixture({
        args,
        expanded: true,
        isPartial: false,
        executionStarted: true,
      });
      const call = tool.renderCall?.(args, plainTheme, context);
      const value = {
        content: [{ type: "text" as const, text: '{"answer":1}' }],
        details: withLedger({
          outputKind: "structured",
          toolCalls: Array.from({ length: 8 }, (_, id) => ({
            tool: "pi.read",
            subject: `file-${id}`,
            status: "completed",
            durationMs: 25000,
            compact: {
              version: 3,
              subject: `file-${id}`,
              outcome: "success",
              issues: [
                { severity: "info", code: "page", message: "More lines", detail: `CONTINUE_${id}` },
              ],
              deliveryFailed: false,
            },
          })),
          counts: { total: 8, succeeded: 8, failed: 0, cancelled: 0, running: 0, queued: 0 },
        }),
      };
      const options = { isPartial: false, expanded: true };
      tool.renderResult?.(opaqueFixture(value), options, plainTheme, context);
      const text = call!.render(160).join("\n");
      expect(text.split("const marker")).toHaveLength(2);
      expect(text.split("Inspect retained calls")).toHaveLength(2);
      expect(text.indexOf("const marker")).toBeLessThan(text.indexOf("file-0"));
      expect(text.indexOf("file-7")).toBeLessThan(text.indexOf('"answer"'));
      expect(text).not.toMatch(/\b25(?:\.0)?s\b/u);
      expect(text).toContain('  "answer": 1');
      for (let id = 0; id < 8; id += 1) {
        // Each expanded-only continuation follows its own child row, once.
        expect(text.split(`CONTINUE_${id}`)).toHaveLength(2);
        expect(text.indexOf(`CONTINUE_${id}`)).toBeGreaterThan(text.indexOf(`file-${id}`));
      }
      for (const width of [8, 16, 80]) {
        expect(call!.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    },
  );
  it("places program source once per presentation path and survives a failed policy capture", () => {
    const restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
    let policy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const owned = definition();
      const args = { code: "return 'SOURCE_MARKER';", intent: "Inspect" };
      const renderContext = (executionStarted: boolean) =>
        opaqueFixture({ args, state: {}, expanded: true, executionStarted, invalidate() {} });
      const context = renderContext(true);
      // Before execution starts there is no result slot, so the call shows the program.
      const pending = owned.renderCall!(args, plainTheme, renderContext(false))
        .render(160)
        .join("\n");
      expect(pending.split("SOURCE_MARKER")).toHaveLength(2);
      const value = {
        content: [{ type: "text" as const, text: "safe output" }],
        details: ledgerDetails([]).details,
      };
      for (const failingPolicy of [false, true]) {
        if (failingPolicy)
          policy = vi
            .spyOn(codePreviews, "captureCodePreviewPresentationPolicy")
            .mockImplementation(() => {
              throw new Error("policy capture");
            });
        // Once started, the original call slot is a header; its result slot owns the program.
        const header = owned.renderCall!(args, plainTheme, context).render(160).join("\n");
        expect(header).toContain("Inspect");
        expect(header).not.toContain("SOURCE_MARKER");
        const original = owned.renderResult!(
          value,
          { isPartial: false, expanded: true },
          plainTheme,
          context,
        )
          .render(160)
          .join("\n");
        expect(original.split("SOURCE_MARKER")).toHaveLength(2);
        expect(original).toContain("safe output");
        // The shell's content slots split the program and the result between them.
        const program = owned.expandedContent.renderCall!(args, plainTheme, context)
          .render(160)
          .join("\n");
        expect(program.split("SOURCE_MARKER")).toHaveLength(2);
        const content = owned.expandedContent.renderResult!(
          value,
          { isPartial: false, expanded: true },
          plainTheme,
          context,
        )
          .render(160)
          .join("\n");
        expect(content).toContain("safe output");
        expect(content).not.toContain("SOURCE_MARKER");
      }
    } finally {
      policy?.mockRestore();
      restore();
    }
  });

  it("keeps hidden call history and output visible without a summary", () => {
    const value = {
      ...result(),
      details: {
        toolCalls: [],
        counts: {
          total: 1,
          failed: 1,
          succeeded: 0,
          cancelled: 0,
          running: 0,
          queued: 0,
        },
      },
    };
    const text = renderCodeModeToolResult(value, { isPartial: false }, plainTheme, {
      expanded: true,
    })
      .component.render(120)
      .join("\n");
    expect(text).toMatch(/\b1\b[^\n]*\bcall\b/u);
    expect(text).toContain("safe output");
  });

  it("does not claim completion in emergency rendering of unsettled or cancelled records", () => {
    for (const value of [
      result("running"),
      { ...result(), details: { ...result().details, cancelled: true } },
    ]) {
      const text = renderCodeModeToolResult(
        value,
        { isPartial: false },
        opaqueFixture({
          fg: () => {
            throw new Error("theme");
          },
        }),
        { expanded: true },
      )
        .component.render(120)
        .join("\n");
      expect(text).not.toContain("completed");
      expect(text).toContain("safe output");
    }
  });

  it("preserves raw text and errors and falls back to plain output when drawing fails", () => {
    const raw = '{"answer":1}';
    for (const [outputKind, isError, truncated, cancelled] of [
      ["text", false, false, false],
      ["structured", true, false, false],
      ["structured", false, true, false],
      ["structured", false, false, true],
    ] as const) {
      const rendered = renderCodeModeToolResult(
        {
          content: [{ type: "text", text: raw }],
          details: { ...result().details, outputKind, truncated, cancelled },
        },
        { isPartial: false },
        plainTheme,
        { expanded: true, isError },
      );
      const text = rendered.component.render(120).join("\n");
      // Only complete, successful structured results are reformatted.
      expect(text).toContain(raw);
      expect(text).not.toContain('"answer": 1');
    }
    const rendered = renderCodeModeToolResult(
      result(),
      { isPartial: false },
      opaqueFixture({
        ...plainTheme,
        fg: () => {
          throw new Error("theme failed");
        },
      }),
      { expanded: true },
      0,
      [],
      {
        summary: {
          subject: "Inspect",
          outcome: "warning",
          issues: [{ severity: "warning", code: "partial", message: "Check state first" }],
        },
      },
    );
    expect(rendered.component.render(120).join("\n")).toContain("safe output");
  });
});
