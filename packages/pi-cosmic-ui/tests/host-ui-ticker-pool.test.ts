// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import { describe, expect, it, vi } from "vitest";
import { makeHostUiTickerOwner } from "../src/boundary/host-status.ts";
import {
  makeHostUiTickerPool,
  type HostUiTickerPool,
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

  it("disposes every active cadence group exactly once", async () => {
    const harness = schedulerHarness();
    const pool = makeHostUiTickerPool(harness.schedule);
    pool.start(160, vi.fn());
    pool.start(1_000, vi.fn());

    const firstDisposal = pool.dispose();
    const secondDisposal = pool.dispose();

    expect(harness.scheduled.map((ticker) => ticker.stop.mock.calls.length)).toEqual([1, 1]);
    expect(secondDisposal).toBe(firstDisposal);
    await firstDisposal;
  });

  it("waits for every tracked ticker closure before disposal settles", async () => {
    let complete!: () => void;
    const stopped = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const stop = Object.assign(vi.fn(), { awaitStopped: () => stopped });
    const schedule: HostUiTickerScheduler = () => stop;
    const pool = makeHostUiTickerPool(schedule);
    const stopSubscription = pool.start(160, vi.fn());
    stopSubscription();

    let settled = false;
    const disposal = pool.dispose().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    complete();
    await disposal;
    expect(settled).toBe(true);
    const postDisposal = vi.fn();
    pool.start(160, postDisposal)();
    expect(postDisposal).not.toHaveBeenCalled();
  });

  it("rotates to a fresh pool while awaiting the previous pool", async () => {
    let finishDisposal!: () => void;
    const disposal = new Promise<void>((resolve) => {
      finishDisposal = resolve;
    });
    const firstStart = vi.fn(() => () => undefined);
    const secondStart = vi.fn(() => () => undefined);
    const pools: HostUiTickerPool[] = [
      { start: firstStart, dispose: vi.fn(() => disposal) },
      { start: secondStart, dispose: vi.fn(() => Promise.resolve()) },
    ];
    let poolIndex = 0;
    const owner = makeHostUiTickerOwner(() => pools[poolIndex++]!);

    owner.start(160, vi.fn());
    let settled = false;
    const shutdown = owner.shutdown().then(() => {
      settled = true;
    });
    owner.start(160, vi.fn());
    await Promise.resolve();

    expect(firstStart).toHaveBeenCalledOnce();
    expect(secondStart).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finishDisposal();
    await shutdown;
    expect(settled).toBe(true);
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
