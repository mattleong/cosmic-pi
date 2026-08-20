import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCosmicFooterClient } from "../footer/client.ts";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { CosmicFooterStatusContribution } from "../protocol/protocol.ts";
import { makeHostUiTickerPool } from "./host-ui-ticker-pool.ts";

const hostUiTickerPool = makeHostUiTickerPool();

/** Shares one underlying Effect timer across all host-UI consumers at the same cadence. */
export const startHostUiTicker = hostUiTickerPool.start;

export const makeSetStatusSafely =
  (statusKey: string) =>
  (ctx: ExtensionContext | undefined, text?: string): void => {
    if (!ctx || ctx.mode !== "tui") return;
    try {
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
  return {
    activate(ctx) {
      let tui = false;
      try {
        tui = ctx?.mode === "tui";
      } catch {
        tui = false;
      }
      if (!tui) {
        client.shutdown();
        return;
      }
      if (client.query()) client.upsert(contribution);
    },
    shutdown() {
      client.shutdown();
    },
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
