import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

export interface HostUiTickerStop {
  (): void;
  readonly awaitStopped?: (() => Promise<void>) | undefined;
}

export type HostUiTickerScheduler = (intervalMs: number, tick: () => void) => HostUiTickerStop;

interface HostUiTickerSubscription {
  readonly tick: () => void;
}

interface HostUiTickerGroup {
  readonly intervalMs: number;
  readonly subscriptions: Set<HostUiTickerSubscription>;
  stop: HostUiTickerStop;
}

export interface HostUiTickerPool {
  readonly start: (intervalMs: number, tick: () => void) => () => void;
  readonly dispose: () => Promise<void>;
}

const closeScope = (scope: Scope.Closeable): Promise<void> => {
  const finalizer = Scope.closeUnsafe(scope, Exit.succeed(undefined));
  return finalizer === undefined
    ? Promise.resolve()
    : Effect.runPromise(finalizer).catch(() => undefined);
};

const scheduleHostUiTicker: HostUiTickerScheduler = (intervalMs, tick) => {
  const scope = Scope.makeUnsafe("sequential");
  try {
    Fiber.runIn(
      Effect.runFork(
        Effect.sleep(Duration.millis(intervalMs)).pipe(
          Effect.andThen(Effect.sync(tick)),
          Effect.forever,
        ),
      ),
      scope,
    );
  } catch (error) {
    void closeScope(scope);
    throw error;
  }
  let closing: Promise<void> | undefined;
  const stop = (): void => {
    closing ??= closeScope(scope);
  };
  return Object.assign(stop, {
    awaitStopped: () => {
      stop();
      return closing ?? Promise.resolve();
    },
  });
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
  const pendingClosures = new Set<Promise<void>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const trackClosure = (closure: Promise<void>): void => {
    const settled = closure.catch(() => undefined);
    pendingClosures.add(settled);
    void settled.then(() => pendingClosures.delete(settled));
  };
  const stopGroup = (group: HostUiTickerGroup): void => {
    try {
      group.stop();
      const closure = group.stop.awaitStopped?.();
      if (closure) trackClosure(closure);
    } catch {
      // Presentation timer cleanup is best effort during component/session teardown.
    }
  };
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
    if (disposed || !Number.isFinite(intervalMs) || intervalMs <= 0) return () => undefined;
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
      stopGroup(activeGroup);
    };
  };

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    for (const group of groups.values()) {
      group.subscriptions.clear();
      stopGroup(group);
    }
    groups.clear();
    disposal = Promise.all(pendingClosures).then(() => undefined);
    return disposal;
  };

  return { start, dispose };
};
