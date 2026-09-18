import * as codePreviews from "pi-code-previews";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { MAX_PROGRESS_ENTRIES } from "../src/tools/format.ts";
import { renderCodeModeToolResult } from "../src/ui/tool-renderer.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { opaqueHostFixture } from "./support/host.ts";

const { withCodePreviewShell } = codePreviews;
const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};
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
    toolCalls: [{ tool: "pi.read", status, activity: "Read safe" }],
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
    expect(details.hasExactCounts).toBe(true);
    expect(details.counts).toEqual({
      total: 5,
      queued: 0,
      running: 1,
      succeeded: 1,
      failed: 3,
      cancelled: 0,
    });
  });

  it("ignores malformed rows and accepts only a valid explicit legacy total", () => {
    const toolCalls = [
      { tool: "pi.read", status: "completed" },
      null,
      { tool: "pi.write" },
      { tool: "pi.grep", status: "unknown" },
    ];
    const malformedTotal = decodeCodeModeRenderDetails({ toolCalls, totalToolCalls: "4" });
    expect(malformedTotal.toolCalls).toHaveLength(1);
    expect(malformedTotal.totalToolCalls).toBe(1);
    expect(malformedTotal.counts.succeeded).toBe(1);

    const explicitTotal = decodeCodeModeRenderDetails({ toolCalls, totalToolCalls: 4 });
    expect(explicitTotal.toolCalls).toHaveLength(1);
    expect(explicitTotal.totalToolCalls).toBe(4);
    expect(explicitTotal.counts.succeeded).toBe(4);
  });

  it("preserves the legacy array total beyond the visible row bound", () => {
    const total = MAX_PROGRESS_ENTRIES + 8;
    const details = decodeCodeModeRenderDetails({
      toolCalls: Array.from({ length: total }, (_, index) => ({
        tool: `pi.read-${index}`,
        status: "completed",
      })),
    });

    expect(details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(details.totalToolCalls).toBe(total);
    expect(details.counts).toEqual({
      total,
      queued: 0,
      running: 0,
      succeeded: total,
      failed: 0,
      cancelled: 0,
    });
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
        opaqueHostFixture(hostileResult),
        options,
        opaqueHostFixture(theme),
        opaqueHostFixture(context),
      ),
    ).not.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("starts and cleans up normal and hostile tickers exactly once", () => {
    for (const hostile of [false, true]) {
      const stop = vi.fn();
      let tick: (() => void) | undefined;
      const start = vi.fn((_interval: number, callback: () => void) => {
        tick = callback;
        return stop;
      });
      const tool = definition(start);
      const invalidate = hostile
        ? () => {
            throw new Error("hostile invalidation");
          }
        : vi.fn();
      const context = opaqueHostFixture({
        expanded: false,
        isError: false,
        state: {},
        invalidate,
      });
      for (let index = 0; index < 2; index += 1)
        tool.renderResult?.(
          result("running"),
          { isPartial: true, expanded: false },
          opaqueHostFixture(theme),
          context,
        );
      expect(start).toHaveBeenCalledOnce();
      expect(() => tick?.()).not.toThrow();
      if (!hostile) expect(invalidate).toHaveBeenCalledOnce();

      for (let index = 0; index < 2; index += 1)
        tool.renderResult?.(
          result("completed"),
          { isPartial: false, expanded: false },
          opaqueHostFixture(theme),
          context,
        );
      expect(stop, String(hostile)).toHaveBeenCalledOnce();
    }
  });

  it.each(["missing", "throwing"])("settles an owned ticker with %s invalidation", (kind) => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const tool = definition(start);
    const state = {};
    tool.renderResult?.(
      result("running"),
      { isPartial: true, expanded: false },
      opaqueHostFixture(theme),
      opaqueHostFixture({ state, invalidate: vi.fn() }),
    );
    expect(start).toHaveBeenCalledOnce();
    expect(state).toHaveProperty("piCodeModeProgressTicker", expect.any(Function));

    const context =
      kind === "missing"
        ? { state }
        : {
            state,
            get invalidate(): never {
              throw new Error("hostile invalidate getter");
            },
          };
    for (let index = 0; index < 2; index += 1) {
      expect(() =>
        tool.renderResult?.(
          result("completed"),
          { isPartial: false, expanded: false },
          opaqueHostFixture(theme),
          opaqueHostFixture(context),
        ),
      ).not.toThrow();
      expect(stop).toHaveBeenCalledOnce();
      expect(state).toHaveProperty("piCodeModeProgressTicker", undefined);
      expect(state).toHaveProperty("piCodeModeProgressInvalidate", undefined);
    }
  });

  it("keeps registered output terminal-safe under hostile content and keybindings", () => {
    const getKeys = vi.fn(() => ["ctrl+o", "\u001b[2Jhostile", "x".repeat(100)]);
    setKeybindings(opaqueHostFixture({ getKeys }));
    const tool = definition();
    const context = opaqueHostFixture({
      expanded: false,
      isError: false,
      state: {},
      invalidate: vi.fn(),
    });
    const collapsed = tool.renderResult?.(
      opaqueHostFixture({
        content: [{ type: "text", text: "safe\u001b[2J output" }],
        details: {},
      }),
      { isPartial: false, expanded: false },
      opaqueHostFixture(theme),
      context,
    );
    tool.renderResult?.(
      result(),
      { isPartial: false, expanded: false },
      opaqueHostFixture(theme),
      context,
    );
    expect(collapsed?.render(80).join("\n")).not.toContain("\u001b");

    expect(() =>
      tool.renderCall?.(
        { intent: "inspect\u001b]0;title\u0007", code: "return '\u001b[2J';" },
        opaqueHostFixture(theme),
        opaqueHostFixture({
          get expanded(): boolean {
            throw new Error("hostile expanded");
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("expanded retained presentation", () => {
  it.each(["off", "on", "border"] as const)(
    "owns one expanded source/header in %s mode and keeps every bounded child before the result",
    (mode) => {
      const previous = codePreviewSettings;
      try {
        setCodePreviewSettings({
          ...previous,
          toolCallCollapsedStyle: "compact",
          toolCallTiming: false,
        });
        const owned = definition();
        const tool = withCodePreviewShell(owned, {
          mode,
          compactSummary: owned.compactSummary,
        });
        const args = {
          code: "const marker = 1; return {answer: marker};",
          intent: "Inspect retained calls",
        };
        const context = opaqueHostFixture({
          args,
          state: {},
          expanded: true,
          isPartial: false,
          isError: false,
          executionStarted: true,
          argsComplete: true,
          invalidate() {},
        });
        const hostTheme = opaqueHostFixture({
          ...theme,
          bg: (_color: string, text: string) => text,
        });
        const call = tool.renderCall?.(args, hostTheme, context);
        const value = {
          content: [{ type: "text" as const, text: '{"answer":1}' }],
          details: {
            outputKind: "structured",
            toolCalls: Array.from({ length: 8 }, (_, id) => ({
              tool: "pi.read",
              subject: `file-${id}`,
              status: "completed",
              durationMs: 25000,
              compact: {
                version: 1,
                subject: `file-${id}`,
                outcome: "success",
                deliveryFailed: false,
                notices: [{ kind: "recovery", text: `CONTINUE_${id}`, expandedOnly: true }],
              },
            })),
            totalToolCalls: 8,
            counts: { total: 8, succeeded: 8, failed: 0, cancelled: 0, running: 0, queued: 0 },
          },
        };
        expect(
          owned.compactSummary({ phase: "settled", args, result: value, context })
            ?.expandedResultOwnsCall,
        ).toBe(true);
        tool.renderResult?.(
          opaqueHostFixture(value),
          { isPartial: false, expanded: true },
          hostTheme,
          context,
        );
        const text = call!.render(160).join("\n");
        expect(text.split("const marker")).toHaveLength(2);
        expect(text.split("Inspect retained calls")).toHaveLength(2);
        expect(text.indexOf("const marker")).toBeLessThan(text.indexOf("file-0"));
        expect(text.indexOf("file-7")).toBeLessThan(text.indexOf('"answer"'));
        expect(text).not.toMatch(/\b25(?:\.0)?s\b/u);
        expect(text).toContain('  "answer": 1');
        for (let id = 0; id < 8; id += 1) {
          // Legacy notices carry no semantic identity; preserve both historical copies.
          expect(text).toContain(`CONTINUE_${id}`);
          expect(text.indexOf(`CONTINUE_${id}`)).toBeGreaterThan(text.indexOf(`file-${id}`));
        }
        for (const width of [8, 16, 80]) {
          expect(call!.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
        }
      } finally {
        setCodePreviewSettings(previous);
      }
    },
  );
  it("declines expanded ownership when presentation capture fails", () => {
    const previous = codePreviewSettings;
    let policy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      setCodePreviewSettings({ ...previous, toolCallCollapsedStyle: "compact" });
      const owned = definition();
      const tool = withCodePreviewShell(owned, {
        mode: "off",
        compactSummary: owned.compactSummary,
      });
      const args = { code: "return 'SOURCE_OWNERSHIP';", intent: "Capture failure" };
      const context = opaqueHostFixture({
        args,
        state: {},
        expanded: true,
        isPartial: false,
        isError: false,
        executionStarted: true,
        argsComplete: true,
        invalidate() {},
      });
      const value = {
        ...result(),
        details: { ...result().details, outputKind: "text", truncated: true },
      };
      const summary = owned.compactSummary({ phase: "settled", args, result: value, context });
      expect(summary?.expandedResultOwnsCall).toBe(true);
      const hostTheme = opaqueHostFixture({ ...theme, bg: (_color: string, text: string) => text });
      const call = tool.renderCall?.(args, hostTheme, context);
      tool.renderResult?.(value, { isPartial: false, expanded: true }, hostTheme, context);
      policy = vi
        .spyOn(codePreviews, "captureCodePreviewPresentationPolicy")
        .mockImplementation(() => {
          throw new Error("policy capture");
        });
      const text = call!.render(240).join("\n");
      expect(text.split("SOURCE_OWNERSHIP")).toHaveLength(2);
      expect(text).toContain("safe output");
      for (const notice of summary?.notices ?? []) expect(text).toContain(notice.text);
    } finally {
      policy?.mockRestore();
      setCodePreviewSettings(previous);
    }
  });

  it("preserves aggregate failure status without an owned expanded header", () => {
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
    const text = renderCodeModeToolResult(value, { isPartial: false }, opaqueHostFixture(theme), {
      expanded: true,
    })
      .component.render(120)
      .join("\n");
    expect(text).toMatch(/1 failed/u);
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
        opaqueHostFixture({
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

  it("preserves raw text and errors and retains source/recovery when expanded drawing fails", () => {
    const raw = '{"answer":1}';
    for (const [outputKind, isError, truncated] of [
      ["text", false, false],
      ["structured", true, false],
      ["structured", false, true],
    ] as const) {
      const rendered = renderCodeModeToolResult(
        {
          content: [{ type: "text", text: raw }],
          details: { ...result().details, outputKind, truncated },
        },
        { isPartial: false },
        opaqueHostFixture(theme),
        { expanded: true, isError },
      );
      expect(rendered.component.render(120).join("\n")).toContain(raw);
    }
    const rendered = renderCodeModeToolResult(
      result(),
      { isPartial: false },
      opaqueHostFixture({
        ...theme,
        fg: () => {
          throw new Error("theme failed");
        },
      }),
      { expanded: true },
      0,
      [],
      {
        ownsCall: true,
        source: "return 'SOURCE_RECOVERY';",
        summary: {
          subject: "Inspect",
          notices: [{ kind: "recovery", text: "Check state first.\nNever replay automatically." }],
        },
      },
    );
    const text = rendered.component.render(120).join("\n");
    expect(text).toContain("SOURCE_RECOVERY");
    expect(text).toContain("safe output");
    expect(text).toContain("Never replay automatically.");
  });
});
