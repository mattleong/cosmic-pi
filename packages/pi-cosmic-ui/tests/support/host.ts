import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  COSMIC_UI_HOST_QUERY,
  normalizeCosmicUiHostQuery,
  type CosmicUiHostQuery,
} from "../../src/protocol/protocol.ts";

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
  const signal: AbortSignal = {
    get aborted() {
      onAbortedRead();
      return source.aborted;
    },
    get reason() {
      const reason: unknown = source.reason;
      return reason;
    },
    get onabort() {
      return source.onabort;
    },
    throwIfAborted: () => source.throwIfAborted(),
    addEventListener,
    removeEventListener,
    dispatchEvent: (event) => source.dispatchEvent(event),
  };
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

export const abortablePendingExec = (
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<ExecResult> =>
  Effect.runPromise(
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(onAbort))),
    signal && { signal },
  );

export const eventBus = (onUnsubscribe: (name: string) => void = () => {}) => {
  const listeners = new Map<string, Set<Parameters<ExtensionAPI["events"]["on"]>[1]>>();
  const emitted: Array<{ readonly name: string; readonly data: unknown }> = [];
  const events: ExtensionAPI["events"] = {
    emit(name, data) {
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
      normalizeCosmicUiHostQuery(data)?.respond(state());
    });
  return { events, emitted, respondToHostQuery };
};
