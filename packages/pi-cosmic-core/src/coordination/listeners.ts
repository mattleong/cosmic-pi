import { invokeHostCallback } from "../host-session.ts";

export const notifyListeners = <Args extends ReadonlyArray<unknown>>(
  listeners: ReadonlySet<(...args: Args) => void>,
  ...args: Args
): void => {
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) invokeHostCallback(() => listener(...args), undefined);
  }
};
