import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCosmicFooterClient, makeHostStateWatch } from "../footer/client.ts";
import { invokeHostCallback, sanitizeTerminalLine } from "pi-cosmic-core";
import type { CosmicFooterStatusContribution } from "../protocol/protocol.ts";
import { makeHostUiTickerPool, type HostUiTickerPool } from "./host-ui-ticker-pool.ts";

export interface HostUiTickerOwner {
  readonly start: HostUiTickerPool["start"];
  readonly shutdown: () => Promise<void>;
}

/** Rotates the process-shared pool before awaiting the old pool's Effect cleanup. */
export const makeHostUiTickerOwner = (
  createPool: () => HostUiTickerPool = makeHostUiTickerPool,
): HostUiTickerOwner => {
  let pool = createPool();
  return {
    start: (intervalMs, tick) => pool.start(intervalMs, tick),
    shutdown: () => {
      const previous = pool;
      pool = createPool();
      return previous.dispose();
    },
  };
};

const hostUiTickerOwner = makeHostUiTickerOwner();

/** Shares one underlying Effect timer across all host-UI consumers at the same cadence. */
export const startHostUiTicker = hostUiTickerOwner.start;

/** Session shutdown awaits the old pool; later sessions use the replacement pool. */
export const shutdownHostUiTickers = hostUiTickerOwner.shutdown;

export const makeSetStatusSafely =
  (statusKey: string) =>
  (ctx: ExtensionContext | undefined, text?: string): void => {
    if (!ctx) return;
    try {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
      const sanitized = text === undefined ? undefined : sanitizeTerminalLine(text) || undefined;
      ctx.ui.setStatus(statusKey, sanitized);
    } catch {
      // Host UI may already be tearing down.
    }
  };

export type FooterStatusPlacement = Omit<CosmicFooterStatusContribution, "kind" | "id">;

export interface FooterStatusDeclaration {
  readonly activate: (ctx: ExtensionContext | undefined) => void;
  readonly shutdown: () => void;
}

/**
 * Declares how a host status entry (`ctx.ui.setStatus`) is placed in the
 * Cosmic footer. Inert when no Cosmic host answers the query; the status text
 * itself keeps flowing through the host status channel either way.
 */
export function makeFooterStatusDeclaration(options: {
  readonly events: ExtensionAPI["events"] | undefined;
  readonly owner: string;
  readonly statusKey: string;
  readonly placement: FooterStatusPlacement;
}): FooterStatusDeclaration {
  const client = createCosmicFooterClient(options.events, options.owner);
  const contribution: CosmicFooterStatusContribution = Object.freeze({
    kind: "status",
    id: options.statusKey,
    ...options.placement,
  });
  let declared = false;
  const watch = makeHostStateWatch(client, (state) => {
    if (declared && state.active) client.upsert(contribution);
  });
  const shutdown = () => {
    declared = false;
    watch.stop();
    client.shutdown();
  };
  return {
    activate(ctx) {
      let tui = false;
      try {
        tui = ctx?.mode === "tui";
      } catch {
        tui = false;
      }
      if (!tui) return shutdown();
      declared = true;
      watch.start();
      client.query();
      if (client.installed) client.upsert(contribution);
    },
    shutdown,
  };
}

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
  /** Optional Cosmic footer placement declaration for this status entry. */
  readonly footerPlacement?: FooterStatusDeclaration;
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
    for (const listener of listeners) invokeHostCallback(listener, undefined);
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
      options.footerPlacement?.activate(next);
      updateFooter();
    },
    setFooterEnabled: (enabled) => {
      footerEnabled = enabled;
      updateFooter();
    },
    clear: () => {
      setStatusSafely(context, undefined);
      options.footerPlacement?.shutdown();
      context = undefined;
      projection = options.emptyProjection();
      notifyListeners();
    },
  };
}
