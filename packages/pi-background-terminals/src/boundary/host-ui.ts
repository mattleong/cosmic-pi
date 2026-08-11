import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import { emptyProjection, footerStatus } from "../job/projection.ts";
import type { BackgroundTerminalProjection } from "../job/model.ts";

export { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-background-terminals";

export interface BackgroundTerminalProjectionBridge {
  readonly get: () => BackgroundTerminalProjection;
  readonly publish: (projection: BackgroundTerminalProjection) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly setFooterEnabled: (enabled: boolean) => void;
  readonly clear: () => void;
}

const setStatusSafely = makeSetStatusSafely(STATUS_KEY);

export function makeProjectionBridge(): BackgroundTerminalProjectionBridge {
  let projection = emptyProjection();
  let context: ExtensionContext | undefined;
  let footerEnabled = true;
  const listeners = new Set<() => void>();

  const updateFooter = () =>
    setStatusSafely(context, footerEnabled ? footerStatus(projection) : undefined);
  const notifyListeners = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One throwing subscriber must not block the other projection listeners.
      }
    }
  };

  return {
    get: () => projection,
    publish: (next) => {
      projection = next;
      updateFooter();
      notifyListeners();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContext: (next) => {
      if (context && context !== next) setStatusSafely(context, undefined);
      context = next;
      updateFooter();
    },
    setFooterEnabled: (enabled) => {
      footerEnabled = enabled;
      updateFooter();
    },
    clear: () => {
      setStatusSafely(context, undefined);
      context = undefined;
      projection = emptyProjection();
      notifyListeners();
    },
  };
}
