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
