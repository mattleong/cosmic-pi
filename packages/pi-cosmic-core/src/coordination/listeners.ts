import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import type * as Scope from "effect/Scope";
import { invokeHostCallback } from "../host-session.ts";

/**
 * Delivers to a snapshot of the registered listeners. A listener removed during delivery is
 * skipped, one added during delivery waits for the next notification, and throws are contained.
 */
export const notifyListeners = <Args extends ReadonlyArray<unknown>>(
  listeners: ReadonlySet<(...args: Args) => void>,
  ...args: Args
): void => {
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) invokeHostCallback(() => listener(...args), undefined);
  }
};

/**
 * Registers a listener for the current scope and removes it when the scope closes. `guard`
 * wraps both steps, for example with the owning service's lock.
 */
export const scopedListener = <Listener>(
  listeners: Set<Listener>,
  listener: Listener,
  guard: (step: Effect.Effect<void>) => Effect.Effect<void> = identity,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(guard(Effect.sync(() => void listeners.add(listener))), () =>
    guard(Effect.sync(() => void listeners.delete(listener))),
  );
