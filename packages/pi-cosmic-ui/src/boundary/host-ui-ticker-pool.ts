import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { invokeHostCallback } from "pi-cosmic-core";

export type HostUiTickerScheduler = (intervalMs: number, tick: () => void) => Fiber.Fiber<void>;

interface HostUiTickerSubscription {
  readonly tick: () => void;
}

interface HostUiTickerGroup {
  readonly intervalMs: number;
  readonly subscriptions: Set<HostUiTickerSubscription>;
  fiber?: Fiber.Fiber<void> | undefined;
}

export interface HostUiTickerPool {
  readonly start: (intervalMs: number, tick: () => void) => () => void;
  readonly dispose: () => Promise<void>;
}

const scheduleHostUiTicker: HostUiTickerScheduler = (intervalMs, tick) =>
  Effect.runFork(
    Effect.sleep(Duration.millis(intervalMs)).pipe(
      Effect.andThen(Effect.sync(tick)),
      Effect.forever,
    ),
  );

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
  const scope = Scope.makeUnsafe("parallel");
  const groups = new Map<number, HostUiTickerGroup>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const stopGroup = (group: HostUiTickerGroup): void =>
    invokeHostCallback(() => group.fiber?.interruptUnsafe(), undefined);
  const invokeGroup = (group: HostUiTickerGroup): void => {
    if (groups.get(group.intervalMs) !== group) return;
    for (const subscription of Array.from(group.subscriptions)) {
      if (!group.subscriptions.has(subscription)) continue;
      invokeHostCallback(() => subscription.tick(), undefined);
    }
  };

  const start = (intervalMs: number, tick: () => void): (() => void) => {
    if (disposed || !Number.isFinite(intervalMs) || intervalMs <= 0) return () => undefined;
    const cadence = Math.max(1, intervalMs);
    const subscription: HostUiTickerSubscription = { tick };
    let group = groups.get(cadence);

    if (group === undefined) {
      const created: HostUiTickerGroup = {
        intervalMs: cadence,
        subscriptions: new Set([subscription]),
      };
      groups.set(cadence, created);
      try {
        const fiber = schedule(cadence, () => invokeGroup(created));
        created.fiber = fiber;
        Fiber.runIn(fiber, scope);
      } catch {
        groups.delete(cadence);
        created.subscriptions.clear();
        stopGroup(created);
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
      stopGroup(activeGroup);
    };
  };

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    for (const group of groups.values()) group.subscriptions.clear();
    groups.clear();
    disposal = Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    return disposal;
  };

  return { start, dispose };
};
