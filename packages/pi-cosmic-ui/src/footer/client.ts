import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicFooterContribution,
  type CosmicFooterInvalidateEvent,
  type CosmicFooterRemoveEvent,
  type CosmicFooterUpsertEvent,
  type CosmicUiHostQuery,
  type CosmicUiHostState,
  normalizeCosmicUiHostStateEvent,
} from "../protocol/protocol.ts";

export interface CosmicFooterClient {
  /** Whether a compatible Cosmic UI host answered the latest query. */
  readonly installed: boolean;
  /** Whether that host currently owns the custom-footer slot. */
  readonly active: boolean;
  readonly isVisible: (id: string) => boolean;
  readonly query: () => boolean;
  readonly onHostStateChange: (listener: (state: CosmicUiHostState) => void) => () => void;
  readonly upsert: (contribution: CosmicFooterContribution) => void;
  readonly remove: (id?: string) => void;
  readonly invalidate: (id?: string) => void;
  readonly shutdown: () => void;
}

/** Plain-data event-bus client. No Effect value or runtime crosses this boundary. */
export function createCosmicFooterClient(
  events: ExtensionAPI["events"] | undefined,
  owner: string,
): CosmicFooterClient {
  let installed = false;
  let active = false;
  let hidden: readonly string[] = [];
  let ready = false;
  const emit = (
    name: string,
    value:
      | CosmicUiHostQuery
      | CosmicFooterUpsertEvent
      | CosmicFooterRemoveEvent
      | CosmicFooterInvalidateEvent,
  ) => {
    try {
      events?.emit(name, value);
    } catch {
      return;
    }
  };
  return {
    get installed() {
      return installed;
    },
    get active() {
      return active;
    },
    isVisible(id) {
      return (!installed || ready) && !hidden.includes(id);
    },
    query() {
      installed = false;
      active = false;
      hidden = [];
      emit(COSMIC_UI_HOST_QUERY, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        respond: (state) => {
          const parsed = normalizeCosmicUiHostStateEvent({
            version: COSMIC_UI_PROTOCOL_VERSION,
            ...state,
          });
          if (!parsed) return;
          installed = true;
          active = parsed.active;
          ready = parsed.ready;
          hidden = parsed.hidden;
        },
      });
      return active;
    },
    onHostStateChange(listener) {
      try {
        return (
          events?.on(COSMIC_UI_HOST_STATE, (data) => {
            const event = normalizeCosmicUiHostStateEvent(data);
            if (!event) return;
            installed = true;
            active = event.active;
            hidden = event.hidden;
            ready = event.ready;
            try {
              listener(Object.freeze({ active, ready, hidden }));
            } catch {
              // A consumer callback cannot break event-bus delivery.
            }
          }) ?? (() => undefined)
        );
      } catch {
        return () => undefined;
      }
    },
    upsert(contribution) {
      if (installed)
        emit(COSMIC_UI_FOOTER_UPSERT, { version: COSMIC_UI_PROTOCOL_VERSION, owner, contribution });
    },
    remove(id) {
      if (!installed) return;
      const event: CosmicFooterRemoveEvent = { version: COSMIC_UI_PROTOCOL_VERSION, owner };
      emit(COSMIC_UI_FOOTER_REMOVE, id === undefined ? event : { ...event, id });
    },
    invalidate(id) {
      if (!installed) return;
      const event: CosmicFooterInvalidateEvent = { version: COSMIC_UI_PROTOCOL_VERSION, owner };
      emit(COSMIC_UI_FOOTER_INVALIDATE, id === undefined ? event : { ...event, id });
    },
    shutdown() {
      const removeOwner = installed;
      installed = false;
      active = false;
      hidden = [];
      if (removeOwner)
        emit(COSMIC_UI_FOOTER_REMOVE, { version: COSMIC_UI_PROTOCOL_VERSION, owner });
    },
  };
}
