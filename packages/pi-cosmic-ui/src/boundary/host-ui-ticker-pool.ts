import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

export type HostUiTickerScheduler = (intervalMs: number, tick: () => void) => () => void;

interface HostUiTickerSubscription {
  readonly tick: () => void;
}

interface HostUiTickerGroup {
  readonly intervalMs: number;
  readonly subscriptions: Set<HostUiTickerSubscription>;
  stop: () => void;
}

export interface HostUiTickerPool {
  readonly start: (intervalMs: number, tick: () => void) => () => void;
}

const scheduleHostUiTicker: HostUiTickerScheduler = (intervalMs, tick) => {
  const fiber = Effect.runFork(
    Effect.sleep(Duration.millis(intervalMs)).pipe(
      Effect.andThen(Effect.sync(tick)),
      Effect.forever,
    ),
  );
  return () => {
    void Effect.runFork(Fiber.interrupt(fiber));
  };
};

/**
 * Multiplexes same-cadence presentation tickers onto one Effect fiber.
 *
 * Animation consumers derive their frame from the shared wall clock, so aligning their wakeups
 * does not alter animation state. It only prevents phase-shifted cards and overlays from asking
 * Pi to render more often than their common cadence.
 */
export const makeHostUiTickerPool = (
  schedule: HostUiTickerScheduler = scheduleHostUiTicker,
): HostUiTickerPool => {
  const groups = new Map<number, HostUiTickerGroup>();

  const invokeGroup = (group: HostUiTickerGroup): void => {
    if (groups.get(group.intervalMs) !== group) return;
    for (const subscription of Array.from(group.subscriptions)) {
      if (!group.subscriptions.has(subscription)) continue;
      try {
        subscription.tick();
      } catch {
        // One tearing-down host component never starves the other consumers in this frame.
      }
    }
  };

  const start = (intervalMs: number, tick: () => void): (() => void) => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => undefined;
    const cadence = Math.max(1, intervalMs);
    const subscription: HostUiTickerSubscription = { tick };
    let group = groups.get(cadence);

    if (group === undefined) {
      const created: HostUiTickerGroup = {
        intervalMs: cadence,
        subscriptions: new Set([subscription]),
        stop: () => undefined,
      };
      groups.set(cadence, created);
      try {
        created.stop = schedule(cadence, () => invokeGroup(created));
      } catch {
        groups.delete(cadence);
        created.subscriptions.clear();
        return () => undefined;
      }
      group = created;
    } else {
      group.subscriptions.add(subscription);
    }

    const activeGroup = group;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeGroup.subscriptions.delete(subscription);
      if (activeGroup.subscriptions.size > 0 || groups.get(cadence) !== activeGroup) return;
      groups.delete(cadence);
      try {
        activeGroup.stop();
      } catch {
        // Presentation timer cleanup is best effort during component/session teardown.
      }
    };
  };

  return { start };
};
