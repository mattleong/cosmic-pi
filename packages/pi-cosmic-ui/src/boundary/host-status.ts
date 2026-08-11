import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

export const startHostUiTicker = (intervalMs: number, tick: () => void): (() => void) => {
  const fiber = Effect.runFork(
    Effect.sleep(intervalMs).pipe(
      Effect.andThen(
        Effect.sync(() => {
          try {
            tick();
          } catch {
            // The host UI may be tearing down between timer ticks.
          }
        }),
      ),
      Effect.forever,
    ),
  );
  return () => {
    void Effect.runFork(Fiber.interrupt(fiber));
  };
};

export const makeSetStatusSafely =
  (statusKey: string) =>
  (ctx: ExtensionContext | undefined, text?: string): void => {
    if (!ctx || ctx.mode !== "tui") return;
    try {
      ctx.ui.setStatus(statusKey, text);
    } catch {
      // Host UI may already be tearing down.
    }
  };

export interface ProjectionBridge<P> {
  readonly get: () => P;
  readonly publish: (projection: P) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly setFooterEnabled: (enabled: boolean) => void;
  readonly clear: () => void;
}

export interface ProjectionBridgeOptions<P> {
  readonly statusKey: string;
  readonly emptyProjection: () => P;
  readonly footerStatus: (projection: P) => string | undefined;
}

export function makeProjectionBridge<P>(options: ProjectionBridgeOptions<P>): ProjectionBridge<P> {
  const setStatusSafely = makeSetStatusSafely(options.statusKey);
  let projection = options.emptyProjection();
  let context: ExtensionContext | undefined;
  let footerEnabled = true;
  const listeners = new Set<() => void>();

  const updateFooter = () =>
    setStatusSafely(context, footerEnabled ? options.footerStatus(projection) : undefined);
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
      projection = options.emptyProjection();
      notifyListeners();
    },
  };
}
