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
