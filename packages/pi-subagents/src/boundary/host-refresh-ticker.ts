import type { SubagentUiRefreshCadence } from "../ui/refresh.ts";

export interface AdaptiveHostRefreshTicker {
  /** Re-evaluates the requested cadence and replaces the host ticker only when it changes. */
  readonly sync: () => void;
  readonly dispose: () => void;
}

export interface AdaptiveHostRefreshTickerOptions {
  readonly getCadence: () => SubagentUiRefreshCadence | undefined;
  readonly startTicker: (intervalMs: number, tick: () => void) => () => void;
  readonly requestRender: () => void;
}

/** Owns one replaceable host ticker for a projection whose repaint cadence can change. */
export const makeAdaptiveHostRefreshTicker = (
  options: AdaptiveHostRefreshTickerOptions,
): AdaptiveHostRefreshTicker => {
  let cadence: SubagentUiRefreshCadence | undefined;
  let stopTicker: (() => void) | undefined;
  let disposed = false;

  const stopCurrent = () => {
    try {
      stopTicker?.();
    } catch {
      // Host ticker cleanup is best effort during TUI teardown.
    }
    stopTicker = undefined;
  };

  const sync = () => {
    if (disposed) return;
    let next: SubagentUiRefreshCadence | undefined;
    try {
      next = options.getCadence();
    } catch {
      next = undefined;
    }
    if (next === cadence) return;
    stopCurrent();
    cadence = undefined;
    if (next === undefined) return;
    try {
      stopTicker = options.startTicker(next, () => {
        if (disposed) return;
        try {
          options.requestRender();
        } catch {
          // The TUI may already be tearing down.
        }
      });
      cadence = next;
    } catch {
      stopTicker = undefined;
    }
  };

  sync();
  return {
    sync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cadence = undefined;
      stopCurrent();
    },
  };
};
