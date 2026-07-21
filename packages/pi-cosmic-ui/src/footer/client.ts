import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicFooterContribution,
} from "../protocol.ts";

export interface CosmicFooterClient {
  readonly active: boolean;
  readonly query: () => boolean;
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
  let active = false;
  const emit = (name: string, value: unknown) => {
    try {
      events?.emit(name, value);
    } catch {
      return;
    }
  };
  return {
    get active() {
      return active;
    },
    query() {
      active = false;
      emit(COSMIC_UI_HOST_QUERY, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        respond: () => {
          active = true;
        },
      });
      return active;
    },
    upsert(contribution) {
      if (active)
        emit(COSMIC_UI_FOOTER_UPSERT, { version: COSMIC_UI_PROTOCOL_VERSION, owner, contribution });
    },
    remove(id) {
      if (active) emit(COSMIC_UI_FOOTER_REMOVE, { version: COSMIC_UI_PROTOCOL_VERSION, owner, id });
    },
    invalidate(id) {
      if (active)
        emit(COSMIC_UI_FOOTER_INVALIDATE, { version: COSMIC_UI_PROTOCOL_VERSION, owner, id });
    },
    shutdown() {
      const removeOwner = active;
      active = false;
      if (removeOwner)
        emit(COSMIC_UI_FOOTER_REMOVE, { version: COSMIC_UI_PROTOCOL_VERSION, owner });
    },
  };
}
