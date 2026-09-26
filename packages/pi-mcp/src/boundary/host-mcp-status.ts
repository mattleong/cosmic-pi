import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { invokeHostCallback } from "pi-cosmic-core";
import { registerActivityProvider, type ActivityProviderRegistration } from "pi-cosmic-ui/activity";
import {
  makeFooterStatusDeclaration,
  makeSetStatusSafely,
} from "pi-cosmic-ui/boundary/host-status";
import {
  mcpActivityDetail,
  mcpFooterStatus,
  projectMcpActivity,
  type McpActivityEntry,
  type McpStatusCounts,
} from "../activity/model.ts";
import type { McpActivityContract } from "../activity/service.ts";

const STATUS_KEY = "pi-mcp";
const emptyCounts: McpStatusCounts = { connected: 0, active: 0, queued: 0, attention: 0 };
export interface McpStatusHostOptions {
  readonly events: ExtensionAPI["events"];
  readonly ctx: ExtensionContext;
  readonly sessionId: string;
  readonly isCurrent: () => boolean;
  readonly activity: McpActivityContract;
  /** Cached safe manager/connection counts. Never submit gateway execute(status) here. */
  readonly counts: () => McpStatusCounts;
  readonly subscribeCounts: (listener: () => void) => () => void;
  /** Named lifecycle capability. It must recheck current manager authority on admission. */
  readonly openManager: (server: string, signal: AbortSignal) => Promise<void>;
}
export interface McpStatusHost {
  readonly publish: () => void;
  readonly dispose: () => void;
}
interface StatusLease {
  readonly generation: number;
  readonly host: McpStatusHost | undefined;
}
// The host bus is process-shared. A replacement retires the old publisher synchronously,
// before acquiring its keyed status; delayed old cleanup is then inert.
const leases = new WeakMap<ExtensionAPI["events"], StatusLease>();

/** Owned host callbacks only. No timer, Effect runtime, network, or credential capability. */
export const makeMcpStatusHost = (options: McpStatusHostOptions): McpStatusHost => {
  const previous = leases.get(options.events);
  let disposed = false;
  let provider: ActivityProviderRegistration | undefined;
  let activityAvailable = false;
  let unsubscribeActivity: (() => void) | undefined;
  let unsubscribeCounts: (() => void) | undefined;
  let lastStatus: string | undefined;
  const generation = (previous?.generation ?? 0) + 1;
  const placement = makeFooterStatusDeclaration({
    events: options.events,
    owner: `pi-mcp.status.${generation}`,
    statusKey: STATUS_KEY,
    placement: { region: "details", order: 1020 },
  });
  const setStatus = makeSetStatusSafely(STATUS_KEY);
  const current = (): boolean =>
    !disposed &&
    invokeHostCallback(options.isCurrent, false) &&
    leases.get(options.events)?.host === host;
  const entries = (): readonly McpActivityEntry[] =>
    current() ? invokeHostCallback(options.activity.snapshot, []) : [];
  const updateStatus = () => {
    if (!current()) return;
    const text = mcpFooterStatus(
      invokeHostCallback(options.counts, emptyCounts),
      entries(),
      activityAvailable,
    );
    if (text === lastStatus) return;
    lastStatus = text;
    setStatus(options.ctx, text);
  };
  const inspect = (id: string, revision: string, signal: AbortSignal) => {
    if (!current() || invokeHostCallback(() => signal.aborted, true)) return undefined;
    return entries().find((entry) => entry.id === id && entry.revision === revision);
  };
  const unavailable = () => new Error("MCP activity is no longer current.");
  const host: McpStatusHost = {
    publish: () => {
      if (!current()) return;
      provider?.publish();
      updateStatus();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      invokeHostCallback(() => unsubscribeActivity?.(), undefined);
      invokeHostCallback(() => unsubscribeCounts?.(), undefined);
      invokeHostCallback(() => provider?.dispose(), undefined);
      placement.shutdown();
      if (leases.get(options.events)?.host === host) {
        // Do not require isCurrent: deactivation revokes it before scoped cleanup.
        setStatus(options.ctx, undefined);
        lastStatus = undefined;
        leases.set(options.events, { generation, host: undefined });
      }
      unsubscribeActivity = undefined;
      unsubscribeCounts = undefined;
      provider = undefined;
    },
  };
  if (!invokeHostCallback(options.isCurrent, false)) {
    disposed = true;
    return host;
  }
  previous?.host?.dispose();
  leases.set(options.events, { generation, host });
  placement.activate(options.ctx);
  unsubscribeActivity = invokeHostCallback(
    () => options.activity.subscribe(host.publish),
    undefined,
  );
  unsubscribeCounts = invokeHostCallback(() => options.subscribeCounts(host.publish), undefined);
  if (invokeHostCallback(() => options.ctx.mode === "tui", false)) {
    provider = invokeHostCallback(
      () =>
        registerActivityProvider(options.events, {
          sessionId: options.sessionId,
          providerId: "pi-mcp",
          snapshot: () => projectMcpActivity(entries()),
          onAvailability: (available) => {
            activityAvailable = available;
            updateStatus();
          },
          invoke: (id, action, revision, signal) => {
            const entry = action === "inspect" ? inspect(id, revision, signal) : undefined;
            if (!entry) return Promise.reject(unavailable());
            try {
              return options.openManager(entry.server, signal).catch(() => {
                throw unavailable();
              });
            } catch {
              return Promise.reject(unavailable());
            }
          },
          getDetail: (id, revision, signal) => {
            const entry = inspect(id, revision, signal);
            return entry
              ? Promise.resolve(mcpActivityDetail(entry))
              : Promise.reject(unavailable());
          },
        }),
      undefined,
    );
  }
  host.publish();
  return host;
};

/** The lifecycle may acquire this inside its existing session scope. */
export const acquireMcpStatusHost = (
  options: McpStatusHostOptions,
): Effect.Effect<McpStatusHost, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeMcpStatusHost(options)),
    (host) => Effect.sync(host.dispose),
  );
