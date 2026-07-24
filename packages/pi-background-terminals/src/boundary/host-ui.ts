import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyProjection, footerStatus } from "../job/projection.ts";
import type { BackgroundTerminalProjection } from "../job/model.ts";

const STATUS_KEY = "pi-background-terminals";

export interface BackgroundTerminalProjectionBridge {
  readonly get: () => BackgroundTerminalProjection;
  readonly publish: (projection: BackgroundTerminalProjection) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly setFooterEnabled: (enabled: boolean) => void;
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

export function makeProjectionBridge(): BackgroundTerminalProjectionBridge {
  let projection = emptyProjection();
  let context: ExtensionContext | undefined;
  let footerEnabled = true;
  const listeners = new Set<() => void>();

  const updateFooter = () =>
    setStatusSafely(context, footerEnabled ? footerStatus(projection) : undefined);

  return {
    get: () => projection,
    publish: (next) => {
      projection = next;
      updateFooter();
      for (const listener of listeners) listener();
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
      for (const listener of listeners) listener();
    },
  };
}
