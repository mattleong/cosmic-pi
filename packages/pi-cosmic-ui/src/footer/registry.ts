import { invokeHostCallback } from "pi-cosmic-core";
import {
  detachCosmicFooterContribution,
  type CosmicFooterContribution,
} from "../protocol/protocol.ts";

export const FOOTER_REENTRANT_OPERATION_LIMIT = 128;
export const FOOTER_PRE_SESSION_KEY_LIMIT = 128;

interface FooterRegistrySnapshot {
  readonly contributions: readonly CosmicFooterContribution[];
}

interface RegistryEntry {
  readonly owner: string;
  readonly contribution: CosmicFooterContribution;
}

export interface FooterRegistry {
  readonly snapshot: () => FooterRegistrySnapshot;
  readonly upsert: (owner: string, contribution: CosmicFooterContribution) => void;
  readonly remove: (owner: string, id?: string) => void;
  readonly clear: () => void;
}

export const createFooterRegistry = (options: {
  readonly requestRender: () => void;
  readonly sessionActive: () => boolean;
}): FooterRegistry => {
  let entries: readonly RegistryEntry[] = [];
  let snapshot: FooterRegistrySnapshot = Object.freeze({ contributions: Object.freeze([]) });
  const queued: Array<() => void> = [];
  let draining = false;
  let accepted = 0;

  const publish = (next: readonly RegistryEntry[]) => {
    entries = next;
    snapshot = Object.freeze({
      contributions: Object.freeze(next.map((entry) => entry.contribution)),
    });
  };
  const serialized = (operation: () => void) => {
    if (draining) {
      if (accepted++ < FOOTER_REENTRANT_OPERATION_LIMIT) queued.push(operation);
      return;
    }
    draining = true;
    accepted = 0;
    try {
      for (let next: (() => void) | undefined = operation; next; next = queued.shift())
        invokeHostCallback(next, undefined);
    } finally {
      draining = false;
      queued.length = 0;
    }
  };

  return {
    snapshot: () => snapshot,
    upsert: (owner, input) => {
      const contribution = detachCosmicFooterContribution(input);
      serialized(() => {
        const index = entries.findIndex(
          (entry) => entry.owner === owner && entry.contribution.id === contribution.id,
        );
        if (entries[index]?.contribution !== contribution) {
          const next = [...entries];
          if (index >= 0) next[index] = { owner, contribution };
          else if (
            next.push({ owner, contribution }) > FOOTER_PRE_SESSION_KEY_LIMIT &&
            !options.sessionActive()
          )
            next.shift();
          publish(next);
        }
        options.requestRender();
      });
    },
    remove: (owner, id) =>
      serialized(() => {
        const next = entries.filter(
          (entry) => entry.owner !== owner || (id !== undefined && entry.contribution.id !== id),
        );
        if (next.length === entries.length) return;
        publish(next);
        options.requestRender();
      }),
    clear: () => {
      queued.length = 0;
      publish([]);
    },
  };
};
