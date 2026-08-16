import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_SPINNER_INTERVAL_MS,
  codeModeAnimationFrame,
  hasRunningCodeModeCall,
  shouldAnimateCodeModeResult,
  syncCodeModeProgressTicker,
} from "../src/tools/animation.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";

describe("Code Mode progress animation", () => {
  it("detects only bounded visible running rows", () => {
    expect(hasRunningCodeModeCall({ toolCalls: [{ status: "running" }] })).toBe(true);
    expect(hasRunningCodeModeCall({ toolCalls: [{ status: "queued" }] })).toBe(false);
    expect(hasRunningCodeModeCall({ toolCalls: "hostile" })).toBe(false);
    expect(hasRunningCodeModeCall(null)).toBe(false);
    expect(
      shouldAnimateCodeModeResult(true, {
        get details() {
          throw new Error("hostile details getter");
        },
      }),
    ).toBe(false);
  });

  it("selects a stable shared-cadence frame index", () => {
    expect(codeModeAnimationFrame(0)).toBe(0);
    expect(codeModeAnimationFrame(CODE_MODE_SPINNER_INTERVAL_MS)).toBe(1);
    expect(codeModeAnimationFrame(-1)).toBe(0);
  });

  it("owns one ticker, follows the latest invalidator, and cancels on settlement", () => {
    const state = {};
    const firstInvalidate = vi.fn();
    const secondInvalidate = vi.fn();
    const stop = vi.fn();
    let tick = () => {};
    const startTicker = vi.fn((intervalMs: number, callback: () => void) => {
      expect(intervalMs).toBe(CODE_MODE_SPINNER_INTERVAL_MS);
      tick = callback;
      return stop;
    });

    syncCodeModeProgressTicker(true, { state, invalidate: firstInvalidate }, startTicker);
    syncCodeModeProgressTicker(true, { state, invalidate: secondInvalidate }, startTicker);
    expect(startTicker).toHaveBeenCalledTimes(1);

    tick();
    expect(firstInvalidate).not.toHaveBeenCalled();
    expect(secondInvalidate).toHaveBeenCalledTimes(1);

    syncCodeModeProgressTicker(false, { state, invalidate: secondInvalidate }, startTicker);
    expect(stop).toHaveBeenCalledTimes(1);
    tick();
    expect(secondInvalidate).toHaveBeenCalledTimes(1);
  });

  it("degrades without persistent host renderer state", () => {
    const startTicker = vi.fn(() => () => {});
    syncCodeModeProgressTicker(true, undefined, startTicker);
    syncCodeModeProgressTicker(true, { state: null, invalidate: () => {} }, startTicker);
    syncCodeModeProgressTicker(true, { state: {}, invalidate: undefined }, startTicker);
    expect(startTicker).not.toHaveBeenCalled();
  });

  it("keeps hostile partial details inside Code Mode's fail-soft renderer", () => {
    const startTicker = vi.fn(() => () => {});
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      bold: (text: string) => text,
      fg: (_key: string, text: string) => text,
    } as Theme;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const tool = buildCodeModeToolDefinition({
      catalogBudget: 500,
      execute: vi.fn() as never,
      startUiTicker: startTicker,
    });
    const hostile = {
      content: [{ type: "text", text: "bounded fallback" }],
      get details(): never {
        throw new Error("hostile details getter");
      },
    };

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    expect(() =>
      tool.renderResult?.(hostile as never, { expanded: false, isPartial: true }, theme, {
        expanded: false,
        isError: false,
        state: {},
        invalidate: () => {},
      } as never),
    ).not.toThrow();
    expect(startTicker).not.toHaveBeenCalled();
  });

  it("connects partial/final tool rendering to ticker ownership", () => {
    const stop = vi.fn();
    const startTicker = vi.fn(() => stop);
    const invalidate = vi.fn();
    const state = {};
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      bold: (text: string) => text,
      fg: (_key: string, text: string) => text,
    } as Theme;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const tool = buildCodeModeToolDefinition({
      catalogBudget: 500,
      execute: vi.fn() as never,
      startUiTicker: startTicker,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const context = { expanded: false, isError: false, state, invalidate } as never;
    const running = {
      content: [{ type: "text" as const, text: "working" }],
      details: { toolCalls: [{ tool: "pi.read", status: "running", activity: "Read file" }] },
    };

    tool.renderResult?.(running, { expanded: false, isPartial: true }, theme, context);
    expect(startTicker).toHaveBeenCalledTimes(1);

    tool.renderResult?.(
      {
        content: [{ type: "text", text: "done" }],
        details: { toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read file" }] },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
