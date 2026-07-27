import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { SubagentProjection } from "../run/model.ts";
import { emptyProjection, fleetStatus } from "../run/projection.ts";

const STATUS_KEY = "pi-subagents";

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

export interface SubagentProjectionBridge {
  readonly get: () => SubagentProjection;
  readonly publish: (projection: SubagentProjection) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly clear: () => void;
}

function setStatusSafely(ctx: ExtensionContext | undefined, text?: string): void {
  if (!ctx || ctx.mode !== "tui") return;
  try {
    ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // Host UI may already be tearing down.
  }
}

export function makeSubagentProjectionBridge(): SubagentProjectionBridge {
  let projection = emptyProjection();
  let context: ExtensionContext | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => projection,
    publish: (next) => {
      projection = next;
      setStatusSafely(context, fleetStatus(next));
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // One stale UI listener cannot block projection publication.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContext: (next) => {
      if (context && context !== next) setStatusSafely(context, undefined);
      context = next;
      setStatusSafely(context, fleetStatus(projection));
    },
    clear: () => {
      setStatusSafely(context, undefined);
      context = undefined;
      projection = emptyProjection();
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // UI teardown is best effort.
        }
      }
    },
  };
}
