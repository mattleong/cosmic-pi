import { setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { MAX_PROGRESS_ENTRIES } from "../src/tools/format.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { opaqueHostFixture } from "./support/host.ts";

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
