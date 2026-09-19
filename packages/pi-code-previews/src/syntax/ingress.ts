import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { makeSynchronousIngress, type SynchronousIngressError } from "pi-cosmic-core";
import type { ProjectionOwnership } from "../shared/projection-ownership";
import { installSyntaxRequests } from "./projection";

const INGRESS_CAPACITY = 32;
const CALLBACK_CAPACITY = 128;

type SyntaxRequest =
  | { readonly tag: "Initialize"; readonly theme: string }
  | { readonly tag: "Language"; readonly language: string };

type PendingRequest = {
  readonly callbacks: (() => void)[];
};

export interface SyntaxIngressHandlers {
  readonly initialize: (theme: string) => Effect.Effect<void>;
  readonly language: (language: string) => Effect.Effect<void>;
}

export interface SyntaxIngress {
  readonly shutdown: Effect.Effect<void>;
}

const requestKey = (request: SyntaxRequest): string =>
  request.tag === "Initialize" ? `initialize:${request.theme}` : `language:${request.language}`;

const invokeHostInvalidation = (callback: (() => void) | undefined): void => {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Renderer invalidation is a hostile synchronous host capability.
  }
};

const invokeCallbacks = (callbacks: readonly (() => void)[]) =>
  Effect.forEach(
    callbacks,
    (callback) => Effect.try({ try: callback, catch: () => undefined }).pipe(Effect.ignore),
    { discard: true },
  );

/** Owns the bounded synchronous renderer-to-Effect request bridge. */
export const makeSyntaxIngress = (
  owner: ProjectionOwnership,
  handlers: SyntaxIngressHandlers,
): Effect.Effect<SyntaxIngress, SynchronousIngressError, Scope.Scope> =>
  Effect.gen(function* () {
    const pendingRequests = new Map<string, PendingRequest>();
    let retainedCallbacks = 0;
    let acceptingRequests = true;

    const takeCallbacks = (key: string): readonly (() => void)[] => {
      const pending = pendingRequests.get(key);
      if (!pending) return [];
      pendingRequests.delete(key);
      retainedCallbacks -= pending.callbacks.length;
      return pending.callbacks;
    };
    const completeRequest = (key: string) =>
      Effect.sync(() => takeCallbacks(key)).pipe(Effect.flatMap(invokeCallbacks));
    const flushPendingCallbacks = Effect.sync(() => {
      const callbacks = [...pendingRequests.values()].flatMap((pending) => pending.callbacks);
      pendingRequests.clear();
      retainedCallbacks = 0;
      for (const callback of callbacks) invokeHostInvalidation(callback);
    });

    const ingress = yield* makeSynchronousIngress<SyntaxRequest, never, never>({
      capacity: INGRESS_CAPACITY,
      overflow: "drop",
      handle: (request) => {
        const key = requestKey(request);
        const operation =
          request.tag === "Language"
            ? handlers.language(request.language)
            : handlers.initialize(request.theme);
        return operation.pipe(Effect.ensuring(completeRequest(key)));
      },
    });

    const retainCallback = (pending: PendingRequest, invalidate?: () => void): void => {
      if (!invalidate) return;
      if (retainedCallbacks >= CALLBACK_CAPACITY) {
        invokeHostInvalidation(invalidate);
        return;
      }
      pending.callbacks.push(invalidate);
      retainedCallbacks++;
    };

    const offerRequest = (request: SyntaxRequest, invalidate?: () => void): void => {
      if (!acceptingRequests) return;
      const key = requestKey(request);
      const pending = pendingRequests.get(key);
      if (pending) {
        retainCallback(pending, invalidate);
        return;
      }
      if (pendingRequests.size >= INGRESS_CAPACITY) {
        invokeHostInvalidation(invalidate);
        return;
      }
      const admitted: PendingRequest = { callbacks: [] };
      pendingRequests.set(key, admitted);
      retainCallback(admitted, invalidate);
      const result = ingress.offer(request);
      switch (result) {
        case "accepted":
          return;
        case "dropped":
        case "coalesced":
        case "closed":
          for (const callback of takeCallbacks(key)) invokeHostInvalidation(callback);
          return;
      }
    };

    installSyntaxRequests(owner, {
      initialize: (theme, invalidate) => offerRequest({ tag: "Initialize", theme }, invalidate),
      language: (language, invalidate) => offerRequest({ tag: "Language", language }, invalidate),
    });

    return {
      shutdown: Effect.sync(() => {
        acceptingRequests = false;
      }).pipe(Effect.andThen(ingress.shutdown), Effect.andThen(flushPendingCallbacks)),
    };
  });
