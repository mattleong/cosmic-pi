import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  invokeHostCallback,
  makeSynchronousIngress,
  type SynchronousIngressError,
} from "pi-cosmic-core";
import type { ProjectionOwnership } from "../shared/projection-ownership";
import { installSyntaxRequests } from "./projection";

const INGRESS_CAPACITY = 32;
const CALLBACK_CAPACITY = 128;

type SyntaxRequest =
  | { readonly tag: "Initialize"; readonly theme: string }
  | { readonly tag: "Language"; readonly language: string };

export interface SyntaxIngressHandlers {
  readonly initialize: (theme: string) => Effect.Effect<void>;
  readonly language: (language: string) => Effect.Effect<void>;
}

export interface SyntaxIngress {
  readonly shutdown: Effect.Effect<void>;
}

const requestKey = (request: SyntaxRequest): string =>
  request.tag === "Initialize" ? `initialize:${request.theme}` : `language:${request.language}`;

const invokeHostInvalidation = (callback: (() => void) | undefined): void =>
  invokeHostCallback(() => callback?.(), undefined);

/** Owns the bounded synchronous renderer-to-Effect request bridge. */
export const makeSyntaxIngress = (
  owner: ProjectionOwnership,
  handlers: SyntaxIngressHandlers,
): Effect.Effect<SyntaxIngress, SynchronousIngressError, Scope.Scope> =>
  Effect.gen(function* () {
    const pendingRequests = new Map<string, (() => void)[]>();
    let retainedCallbacks = 0;
    let acceptingRequests = true;

    const invalidateRequest = (key: string): void => {
      const callbacks = pendingRequests.get(key);
      if (!callbacks) return;
      pendingRequests.delete(key);
      retainedCallbacks -= callbacks.length;
      for (const callback of callbacks) invokeHostInvalidation(callback);
    };
    const flushPendingCallbacks = Effect.sync(() => {
      for (const key of pendingRequests.keys()) invalidateRequest(key);
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
        return operation.pipe(Effect.ensuring(Effect.sync(() => invalidateRequest(key))));
      },
    });

    const retainCallback = (callbacks: (() => void)[], invalidate?: () => void): void => {
      if (!invalidate) return;
      if (retainedCallbacks >= CALLBACK_CAPACITY) {
        invokeHostInvalidation(invalidate);
        return;
      }
      callbacks.push(invalidate);
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
      const admitted: (() => void)[] = [];
      pendingRequests.set(key, admitted);
      retainCallback(admitted, invalidate);
      if (ingress.offer(request) !== "accepted") invalidateRequest(key);
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
