import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { deferredPromise } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { COSMIC_UI_HOST_QUERY, type CosmicUiHostQuery } from "../../src/protocol/protocol.ts";

/** A real AbortSignal whose `aborted` reads and listener registrations are observable. */
export function capturedSignal(
  source = new AbortController().signal,
  onAbortedRead = () => {},
  throwAfterAdd = false,
) {
  const addEventListener = vi.fn((...args: Parameters<AbortSignal["addEventListener"]>) => {
    source.addEventListener(...args);
    if (throwAfterAdd) throw new Error("registered before throwing");
  });
  const removeEventListener = vi.fn(source.removeEventListener.bind(source));
  const signal = new Proxy(source, {
    get(target, property) {
      if (property === "aborted") onAbortedRead();
      if (property === "addEventListener") return addEventListener;
      if (property === "removeEventListener") return removeEventListener;
      // SAFETY: The in check proves this property belongs to the AbortSignal contract.
      const value = property in target ? target[property as keyof AbortSignal] : undefined;
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
  return { signal, addEventListener, removeEventListener };
}

export type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
export const execResult = (stdout = "", code = 0): ExecResult => ({
  stdout,
  stderr: "",
  code,
  killed: false,
});
export const execOk = (stdout?: string) => Promise.resolve(execResult(stdout));

/** Pending host exec promise that rejects when the probe signal aborts. */
export const abortablePendingExec = (
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<ExecResult> => {
  const pending = deferredPromise<ExecResult>();
  signal?.addEventListener(
    "abort",
    () => {
      onAbort();
      pending.reject(new Error("aborted"));
    },
    { once: true },
  );
  return pending.promise;
};

/** Synchronous in-memory event bus that records every emitted event. */
export const eventBus = (onUnsubscribe: (name: string) => void = () => {}) => {
  const listeners = new Map<string, Set<Parameters<ExtensionAPI["events"]["on"]>[1]>>();
  const emitted: Array<{ readonly name: string; readonly data: unknown }> = [];
  const events: ExtensionAPI["events"] = {
    emit<DataInput>(name: string, data: DataInput) {
      emitted.push({ name, data });
      for (const listener of listeners.get(name) ?? []) listener(data);
    },
    on(name, listener) {
      const entries = listeners.get(name) ?? new Set();
      entries.add(listener);
      listeners.set(name, entries);
      return () => {
        entries.delete(listener);
        onUnsubscribe(name);
      };
    },
  };
  const respondToHostQuery = (state: () => Parameters<CosmicUiHostQuery["respond"]>[0]) =>
    events.on(COSMIC_UI_HOST_QUERY, (data) => {
      // SAFETY: Only typed host queries are emitted on this event.
      (data as CosmicUiHostQuery).respond(state());
    });
  return { events, emitted, respondToHostQuery };
};
