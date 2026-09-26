import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { deferredPromise } from "pi-cosmic-core/testing";
import { COSMIC_UI_HOST_QUERY, type CosmicUiHostQuery } from "../../src/protocol/protocol.ts";

export const footerDataProviderFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ReadonlyFooterDataProvider => {
  // SAFETY: Each test invokes only the footer-data members explicitly implemented here.
  return fixture as Fixture & ReadonlyFooterDataProvider;
};

export const abortSignalFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & AbortSignal => {
  // SAFETY: Each test invokes only the AbortSignal members explicitly implemented here.
  return fixture as Fixture & AbortSignal;
};

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
