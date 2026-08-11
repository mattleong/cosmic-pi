import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import type { SubagentProjection } from "../run/model.ts";
import { emptyProjection, fleetStatus } from "../run/projection.ts";

export { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-subagents";

export interface SubagentProjectionBridge {
  readonly get: () => SubagentProjection;
  readonly publish: (projection: SubagentProjection) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly clear: () => void;
}

const setStatusSafely = makeSetStatusSafely(STATUS_KEY);

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
