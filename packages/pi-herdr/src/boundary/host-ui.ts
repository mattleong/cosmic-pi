import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdrProjection } from "../herd/model.ts";
import { emptyHerdrProjection, herdrFooterStatus } from "../herd/projection.ts";

const STATUS_KEY = "pi-herdr";

export interface HerdrProjectionBridge {
  readonly get: () => HerdrProjection;
  readonly publish: (projection: HerdrProjection) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly setFooterEnabled: (enabled: boolean) => void;
  readonly clear: () => void;
}

const setStatusSafely = (
  ctx: ExtensionContext | undefined,
  enabled: boolean,
  projection: HerdrProjection,
): void => {
  if (!ctx || ctx.mode !== "tui") return;
  try {
    ctx.ui.setStatus(STATUS_KEY, enabled ? herdrFooterStatus(projection) : undefined);
  } catch {
    // Host UI teardown is best effort.
  }
};

export function makeHerdrProjectionBridge(): HerdrProjectionBridge {
  let projection = emptyHerdrProjection();
  let context: ExtensionContext | undefined;
  let footerEnabled = true;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A stale listener cannot block projection publication.
      }
    }
  };
  return {
    get: () => projection,
    publish: (next) => {
      projection = next;
      setStatusSafely(context, footerEnabled, projection);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContext: (next) => {
      if (context && context !== next) setStatusSafely(context, false, projection);
      context = next;
      setStatusSafely(context, footerEnabled, projection);
    },
    setFooterEnabled: (enabled) => {
      footerEnabled = enabled;
      setStatusSafely(context, footerEnabled, projection);
    },
    clear: () => {
      setStatusSafely(context, false, projection);
      context = undefined;
      projection = emptyHerdrProjection();
      notify();
    },
  };
}
