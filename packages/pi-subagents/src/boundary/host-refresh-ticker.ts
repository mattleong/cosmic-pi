import { invokeHostCallback } from "pi-cosmic-core/host-session";
import type { SubagentUiRefreshCadence } from "../ui/refresh.ts";

export interface AdaptiveHostRefreshTicker {
  readonly sync: () => void;
  readonly dispose: () => void;
}

interface AdaptiveHostRefreshTickerOptions {
  readonly getCadence: () => SubagentUiRefreshCadence | undefined;
  readonly startTicker: (intervalMs: number, tick: () => void) => () => void;
  readonly requestRender: () => void;
}

export const adaptiveHostRefreshTicker = (
  options: AdaptiveHostRefreshTickerOptions,
): AdaptiveHostRefreshTicker => {
  let cadence: SubagentUiRefreshCadence | undefined;
  let stopTicker: (() => void) | undefined;
  let disposed = false;

  const stopCurrent = () => {
    invokeHostCallback(() => stopTicker?.(), undefined);
    stopTicker = undefined;
  };

  const sync = () => {
    if (disposed) return;
    const next = invokeHostCallback(() => options.getCadence(), undefined);
    if (next === cadence) return;
    stopCurrent();
    cadence = undefined;
    if (next === undefined) return;
    try {
      stopTicker = options.startTicker(next, () => {
        if (!disposed) invokeHostCallback(() => options.requestRender(), undefined);
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
