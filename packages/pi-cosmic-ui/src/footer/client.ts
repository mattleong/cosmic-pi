import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicFooterContribution,
  type CosmicFooterRemoveEvent,
  type CosmicFooterUpsertEvent,
  type CosmicUiHostQuery,
  type CosmicUiHostState,
  normalizeCosmicUiHostStateEvent,
} from "../protocol/protocol.ts";

interface CosmicFooterClient {
  /** Whether a compatible Cosmic UI host answered the latest query. */
  readonly installed: boolean;
  /** Whether that host currently owns the custom-footer slot. */
  readonly active: boolean;
  readonly isVisible: (id: string) => boolean;
  readonly query: () => boolean;
  readonly onHostStateChange: (listener: (state: CosmicUiHostState) => void) => () => void;
  readonly upsert: (contribution: CosmicFooterContribution) => void;
  readonly remove: (id: string) => void;
  readonly shutdown: () => void;
}

const noop = () => undefined;

/** Plain-data event-bus client. No Effect value or runtime crosses this boundary. */
export function createCosmicFooterClient(
  events: ExtensionAPI["events"] | undefined,
  owner: string,
): CosmicFooterClient {
  /** The latest valid host state; undefined until a compatible host answers. */
  let host: CosmicUiHostState | undefined;
  const emit = (
    name: string,
    value: CosmicUiHostQuery | CosmicFooterUpsertEvent | CosmicFooterRemoveEvent,
  ) => invokeHostCallback(() => events?.emit(name, value), undefined);
  const active = () => host?.active ?? false;
  return {
    get installed() {
      return host !== undefined;
    },
    get active() {
      return active();
    },
    isVisible: (id) => (host?.ready ?? true) && !(host?.hidden.includes(id) ?? false),
    query() {
      host = undefined;
      emit(COSMIC_UI_HOST_QUERY, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        respond: (state) => {
          host =
            normalizeCosmicUiHostStateEvent({ version: COSMIC_UI_PROTOCOL_VERSION, ...state }) ??
            host;
        },
      });
      return active();
    },
    onHostStateChange: (listener) =>
      invokeHostCallback(
        () =>
          events?.on(COSMIC_UI_HOST_STATE, (data) => {
            const event = normalizeCosmicUiHostStateEvent(data);
            if (!event) return;
            host = event;
            const { active, ready, hidden } = event;
            invokeHostCallback(() => listener(Object.freeze({ active, ready, hidden })), undefined);
          }) ?? noop,
        noop,
      ),
    upsert(contribution) {
      if (host)
        emit(COSMIC_UI_FOOTER_UPSERT, { version: COSMIC_UI_PROTOCOL_VERSION, owner, contribution });
    },
    remove(id) {
      if (host) emit(COSMIC_UI_FOOTER_REMOVE, { version: COSMIC_UI_PROTOCOL_VERSION, owner, id });
    },
    shutdown() {
      const removeOwner = host !== undefined;
      host = undefined;
      if (removeOwner)
        emit(COSMIC_UI_FOOTER_REMOVE, { version: COSMIC_UI_PROTOCOL_VERSION, owner });
    },
  };
}

interface HostStateWatch {
  readonly start: () => void;
  readonly stop: () => void;
}

/** Idempotent host-state subscription; `start` while already watching is a no-op. */
export function makeHostStateWatch(
  client: Pick<CosmicFooterClient, "onHostStateChange">,
  listener: (state: CosmicUiHostState) => void,
): HostStateWatch {
  let unsubscribe: (() => void) | undefined;
  return {
    start: () => {
      unsubscribe ??= client.onHostStateChange(listener);
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
