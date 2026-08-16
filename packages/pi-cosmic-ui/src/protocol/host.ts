import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { makeSynchronousIngress, type SynchronousIngressOfferResult } from "pi-cosmic-core";
import { FooterRegistryService } from "../footer/registry.ts";
import type {
  CosmicFooterContribution,
  CosmicFooterInvalidateEvent,
  CosmicFooterRemoveEvent,
  CosmicFooterUpsertEvent,
} from "./protocol.ts";

interface MutableRemoveProtocolEvent {
  _tag: "Remove";
  owner: string;
  id?: string;
}

interface MutableInvalidateProtocolEvent {
  _tag: "Invalidate";
  owner?: string;
  id?: string;
}

export type FooterProtocolEvent =
  | {
      readonly _tag: "Upsert";
      readonly owner: string;
      readonly contribution: CosmicFooterContribution;
    }
  | { readonly _tag: "Remove"; readonly owner: string; readonly id?: string }
  | { readonly _tag: "Invalidate"; readonly owner?: string; readonly id?: string };

export interface FooterProtocolBufferStats {
  readonly buffered: number;
  readonly dropped: number;
  readonly active: boolean;
}

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
  readonly stats: () => FooterProtocolBufferStats;
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
  let dropped = 0;
  let reserved = 0;

  const offer = (raw: FooterProtocolEvent): SynchronousIngressOfferResult => {
    const event = freezeEvent(raw);
    if (consumer) {
      const result = consumer(event);
      if (result === "dropped" || result === "closed") dropped++;
      return result;
    }
    if (pending.length + reserved >= limit) {
      if (pending.length === 0) {
        dropped++;
        return "dropped";
      }
      pending.shift();
      dropped++;
    }
    pending.push(event);
    return "accepted";
  };
  const activate = (next: (event: FooterProtocolEvent) => SynchronousIngressOfferResult) => {
    consumer = next;
    for (const event of pending.splice(0)) {
      const result = next(event);
      if (result === "dropped" || result === "closed") dropped++;
    }
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
      dropped = 0;
      reserved = 0;
    },
    stats: () =>
      Object.freeze({ buffered: pending.length + reserved, dropped, active: !!consumer }),
  };
}

export const protocolUpsert = (event: CosmicFooterUpsertEvent): FooterProtocolEvent => ({
  _tag: "Upsert",
  owner: event.owner,
  contribution: event.contribution,
});
export const protocolRemove = (event: CosmicFooterRemoveEvent): FooterProtocolEvent => {
  const protocolEvent: MutableRemoveProtocolEvent = {
    _tag: "Remove",
    owner: event.owner,
  };
  if (event.id !== undefined) protocolEvent.id = event.id;
  return protocolEvent;
};
export const protocolInvalidate = (event: CosmicFooterInvalidateEvent): FooterProtocolEvent => {
  const protocolEvent: MutableInvalidateProtocolEvent = {
    _tag: "Invalidate",
  };
  if (event.owner !== undefined) protocolEvent.owner = event.owner;
  if (event.id !== undefined) protocolEvent.id = event.id;
  return protocolEvent;
};

/** Scoped protocol ingress ownership. The host publishes through the registry, not this handle. */
export type FooterProtocolHostContract = Readonly<Record<never, never>>;

export class FooterProtocolHost extends Context.Service<
  FooterProtocolHost,
  FooterProtocolHostContract
>()("pi-cosmic-ui/protocol/host/FooterProtocolHost") {
  static layer(options: {
    readonly buffer: FooterProtocolBuffer;
    readonly ingressCapacity?: number;
  }) {
    return Layer.effect(
      this,
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
        return FooterProtocolHost.of({});
      }),
    );
  }
}
