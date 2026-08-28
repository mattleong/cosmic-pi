import { describe, expect, it, vi } from "vitest";
import { makeAdaptiveHostRefreshTicker } from "../src/boundary/host-refresh-ticker.ts";
import type { SubagentUiRefreshCadence } from "../src/ui/refresh.ts";

describe("adaptive host refresh ticker", () => {
  it("replaces cadence stop-before-start and becomes idle when no repaint is needed", () => {
    let cadence: SubagentUiRefreshCadence | undefined = 1_000;
    const events: string[] = [];
    const ticks = new Map<number, () => void>();
    const startTicker = vi.fn((intervalMs: number, tick: () => void) => {
      events.push(`start:${intervalMs}`);
      ticks.set(intervalMs, tick);
      return () => {
        events.push(`stop:${intervalMs}`);
        ticks.delete(intervalMs);
      };
    });
    const requestRender = vi.fn();
    const ticker = makeAdaptiveHostRefreshTicker({
      getCadence: () => cadence,
      startTicker,
      requestRender,
    });

    expect(events).toEqual(["start:1000"]);
    ticker.sync();
    expect(events).toEqual(["start:1000"]);

    cadence = 160;
    ticker.sync();
    expect(events).toEqual(["start:1000", "stop:1000", "start:160"]);
    ticks.get(160)?.();
    expect(requestRender).toHaveBeenCalledOnce();

    cadence = undefined;
    ticker.sync();
    expect(events).toEqual(["start:1000", "stop:1000", "start:160", "stop:160"]);
    ticker.dispose();
    ticker.dispose();
    expect(events).toHaveLength(4);
  });

  it("ignores late ticks after disposal and contains host callback failures", () => {
    let tick: (() => void) | undefined;
    const stop = vi.fn();
    const ticker = makeAdaptiveHostRefreshTicker({
      getCadence: () => 160,
      startTicker: (_intervalMs, next) => {
        tick = next;
        return stop;
      },
      requestRender: () => {
        throw new Error("stale TUI");
      },
    });

    expect(() => tick?.()).not.toThrow();
    ticker.dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(() => tick?.()).not.toThrow();
  });
});
