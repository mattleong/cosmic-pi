import { describe, expect, it, vi } from "vitest";
import {
  makeHostUiTickerPool,
  type HostUiTickerScheduler,
} from "../src/boundary/host-ui-ticker-pool.ts";

interface ScheduledTicker {
  readonly intervalMs: number;
  readonly tick: () => void;
  readonly stop: ReturnType<typeof vi.fn>;
}

const schedulerHarness = () => {
  const scheduled: ScheduledTicker[] = [];
  const schedule: HostUiTickerScheduler = (intervalMs, tick) => {
    const stop = vi.fn();
    scheduled.push({ intervalMs, tick, stop });
    return stop;
  };
  return { schedule, scheduled };
};

describe("host UI ticker pool", () => {
  it("shares one underlying ticker between same-cadence consumers", () => {
    const harness = schedulerHarness();
    const pool = makeHostUiTickerPool(harness.schedule);
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = pool.start(160, first);
    const stopSecond = pool.start(160, second);

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]?.intervalMs).toBe(160);
    harness.scheduled[0]?.tick();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    stopFirst();
    stopFirst();
    expect(harness.scheduled[0]?.stop).not.toHaveBeenCalled();
    harness.scheduled[0]?.tick();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);

    stopSecond();
    stopSecond();
    expect(harness.scheduled[0]?.stop).toHaveBeenCalledOnce();
  });

  it("keeps different cadences independent and creates a fresh group after teardown", () => {
    const harness = schedulerHarness();
    const pool = makeHostUiTickerPool(harness.schedule);
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = pool.start(160, first);
    const stopSecond = pool.start(1_000, second);
    expect(harness.scheduled.map((ticker) => ticker.intervalMs)).toEqual([160, 1_000]);

    stopFirst();
    const replacement = vi.fn();
    const stopReplacement = pool.start(160, replacement);
    expect(harness.scheduled.map((ticker) => ticker.intervalMs)).toEqual([160, 1_000, 160]);

    // A stale scheduler callback cannot reach the replacement group.
    harness.scheduled[0]?.tick();
    expect(replacement).not.toHaveBeenCalled();
    harness.scheduled[2]?.tick();
    expect(replacement).toHaveBeenCalledOnce();

    stopReplacement();
    stopSecond();
  });

  it("isolates throwing and reentrantly removed consumers", () => {
    const harness = schedulerHarness();
    const pool = makeHostUiTickerPool(harness.schedule);
    const throwing = vi.fn(() => {
      throw new Error("host teardown");
    });
    const removed = vi.fn();
    let stopRemoved: () => void = () => undefined;
    const remover = vi.fn(() => stopRemoved());

    pool.start(160, throwing);
    pool.start(160, remover);
    stopRemoved = pool.start(160, removed);

    expect(() => harness.scheduled[0]?.tick()).not.toThrow();
    expect(throwing).toHaveBeenCalledOnce();
    expect(remover).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it("fails soft for invalid intervals and scheduler failures", () => {
    const schedule = vi.fn<HostUiTickerScheduler>(() => {
      throw new Error("scheduler unavailable");
    });
    const pool = makeHostUiTickerPool(schedule);
    const tick = vi.fn();

    expect(() => pool.start(Number.NaN, tick)()).not.toThrow();
    expect(() => pool.start(0, tick)()).not.toThrow();
    expect(schedule).not.toHaveBeenCalled();
    expect(() => pool.start(160, tick)()).not.toThrow();
    expect(schedule).toHaveBeenCalledOnce();
    expect(tick).not.toHaveBeenCalled();
  });
});
