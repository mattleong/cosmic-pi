import { setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
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

  it("captures bounded expand keys once and keeps registered output terminal-safe", () => {
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
    expect(getKeys).toHaveBeenCalledOnce();
    expect(collapsed?.render(80).join("\n")).toContain("ctrl+o/");
    expect(collapsed?.render(80).join("\n")).toContain("expand");
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
