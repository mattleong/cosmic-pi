import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { makeSynchronousIngress, type SynchronousIngressOfferResult } from "pi-cosmic-core";
import { FooterRegistryService } from "../footer/registry.ts";
import type { CosmicFooterContribution } from "./protocol.ts";

export type FooterProtocolEvent =
  | {
      readonly _tag: "Upsert";
      readonly owner: string;
      readonly contribution: CosmicFooterContribution;
    }
  | { readonly _tag: "Remove"; readonly owner: string; readonly id?: string }
  | { readonly _tag: "Invalidate"; readonly owner?: string; readonly id?: string };

export interface FooterProtocolBuffer {
  readonly offer: (event: FooterProtocolEvent) => SynchronousIngressOfferResult;
  readonly activate: (
    consumer: (event: FooterProtocolEvent) => SynchronousIngressOfferResult,
  ) => void;
  readonly takePending: () => FooterProtocolEvent | undefined;
  readonly completePending: () => void;
  readonly restorePending: (event: FooterProtocolEvent) => void;
  readonly deactivate: () => void;
  readonly reset: () => void;
}

const freezeEvent = (event: FooterProtocolEvent): FooterProtocolEvent => {
  if (event._tag !== "Upsert") return Object.freeze({ ...event });
  return Object.freeze({
    ...event,
    contribution: Object.freeze({ ...event.contribution }),
  });
};

/** Bounded plain-data/capability buffer used before a session runtime is active. */
export function makeFooterProtocolBuffer(capacity = 128): FooterProtocolBuffer {
  const limit = Math.max(1, Math.floor(capacity));
  const pending: FooterProtocolEvent[] = [];
  let consumer: ((event: FooterProtocolEvent) => SynchronousIngressOfferResult) | undefined;
  let reserved = 0;

  const offer = (raw: FooterProtocolEvent): SynchronousIngressOfferResult => {
    const event = freezeEvent(raw);
    if (consumer) return consumer(event);
    if (pending.length + reserved >= limit) {
      if (pending.length === 0) return "dropped";
      pending.shift();
    }
    pending.push(event);
    return "accepted";
  };
  const activate = (next: (event: FooterProtocolEvent) => SynchronousIngressOfferResult) => {
    consumer = next;
    for (const event of pending.splice(0)) next(event);
  };
  return {
    offer,
    activate,
    takePending: () => {
      const event = pending.shift();
      if (event !== undefined) reserved++;
      return event;
    },
    completePending: () => {
      if (reserved > 0) reserved--;
    },
    restorePending: (event) => {
      if (reserved > 0) reserved--;
      pending.unshift(freezeEvent(event));
    },
    deactivate: () => {
      consumer = undefined;
    },
    reset: () => {
      consumer = undefined;
      pending.length = 0;
      reserved = 0;
    },
  };
}

export const protocolUpsert = (
  owner: string,
  contribution: CosmicFooterContribution,
): FooterProtocolEvent => ({ _tag: "Upsert", owner, contribution });
export const protocolRemove = (owner: string, id?: string): FooterProtocolEvent =>
  id === undefined ? { _tag: "Remove", owner } : { _tag: "Remove", owner, id };
export const protocolInvalidate = (owner?: string, id?: string): FooterProtocolEvent =>
  owner === undefined
    ? id === undefined
      ? { _tag: "Invalidate" }
      : { _tag: "Invalidate", id }
    : id === undefined
      ? { _tag: "Invalidate", owner }
      : { _tag: "Invalidate", owner, id };

/** Scoped protocol ingress ownership. The host publishes through the registry. */
export const makeFooterProtocolHostLayer = (options: {
  readonly buffer: FooterProtocolBuffer;
  readonly ingressCapacity?: number;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* FooterRegistryService;
      const handle = (event: FooterProtocolEvent) => {
        switch (event._tag) {
          case "Upsert":
            return registry.upsert(event.owner, event.contribution);
          case "Remove":
            return registry.remove(event.owner, event.id);
          case "Invalidate":
            return registry.invalidate(event.owner, event.id);
        }
      };
      const ingress = yield* makeSynchronousIngress<FooterProtocolEvent, never, never>({
        capacity: options.ingressCapacity ?? 128,
        overflow: "drop",
        handle,
      });
      while (true) {
        const pending = options.buffer.takePending();
        if (pending === undefined) break;
        yield* handle(pending).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => options.buffer.restorePending(pending))
              : Effect.sync(() => options.buffer.completePending()),
          ),
        );
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => options.buffer.activate(ingress.offer)),
        () => Effect.sync(() => options.buffer.deactivate()),
      );
    }),
  );
