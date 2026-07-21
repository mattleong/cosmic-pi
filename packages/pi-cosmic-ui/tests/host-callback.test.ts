import { describe, expect, it, vi } from "vitest";
import {
  makeHostCallbackBoundary,
  snapshotHostAbortSignal,
} from "../src/boundary/host-callback.ts";

function controlledSignal(registerThenThrow = false) {
  let aborted = false;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const addEventListener = vi.fn(
    (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) listeners.add(listener);
      if (registerThenThrow) throw new Error("registered before throwing");
    },
  );
  const removeEventListener = vi.fn(
    (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) listeners.delete(listener);
    },
  );
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener,
    removeEventListener,
  } as unknown as AbortSignal;
  const abort = () => {
    aborted = true;
    const event = new Event("abort");
    for (const listener of listeners) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  };
  return { signal, abort, listeners, addEventListener, removeEventListener };
}

describe("host callback abort ownership", () => {
  it("forwards an abort that happens after capture and releases exactly once", () => {
    const source = controlledSignal();
    const snapshot = snapshotHostAbortSignal(makeHostCallbackBoundary(), () => source.signal);
    expect(snapshot?.aborted).toBe(false);
    expect(source.listeners.size).toBe(1);

    source.abort();
    expect(snapshot?.signal?.aborted).toBe(true);
    snapshot?.release();
    snapshot?.release();

    expect(source.removeEventListener).toHaveBeenCalledOnce();
    expect(source.listeners.size).toBe(0);
  });

  it("attempts release when a hostile source registers and then throws", () => {
    const callbacks = makeHostCallbackBoundary();
    const source = controlledSignal(true);
    const snapshot = snapshotHostAbortSignal(callbacks, () => source.signal);

    expect(snapshot).toBeUndefined();
    expect(source.removeEventListener).toHaveBeenCalledOnce();
    expect(source.listeners.size).toBe(0);
    expect(callbacks.diagnostics()).toEqual([{ operation: "host-query" }]);
  });
});
