import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  footerDataFixture,
  plainTheme,
  tuiFixture,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  COSMIC_UI_HOST_QUERY,
  normalizeCosmicUiHostQuery,
  type CosmicUiHostQuery,
} from "../../src/protocol/protocol.ts";

export const capturedSignal = (signal = new AbortController().signal) => ({
  signal,
  addEventListener: vi.spyOn(signal, "addEventListener"),
  removeEventListener: vi.spyOn(signal, "removeEventListener"),
});

export type AssistantMessage = Extract<
  ExtensionEventNamed<"message_end">["message"],
  { readonly role: "assistant" }
>;

export const nativeUsage = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

/** A persisted usage entry, as the host writes one for cache warming unless `kind` says otherwise. */
export const usageEntry = (
  input: number,
  { kind = "cache_warm", usage = nativeUsage(input) } = {},
): SessionEntries[number] => ({
  id: "entry",
  parentId: null,
  timestamp: "2026-01-01T00:00:00Z",
  type: "usage",
  kind,
  provider: "test",
  model: "test",
  usage,
});

export type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
export type FooterData = Parameters<FooterFactory>[2];

/** Mounts an installed footer factory on a fake TUI with one available provider. */
export function makeFooter(
  factory: FooterFactory | undefined,
  data: Partial<FooterData> = {},
  requestRender: () => void = vi.fn(),
) {
  if (!factory) throw new Error("Expected an installed footer factory.");
  const component = factory(
    tuiFixture({ requestRender }),
    plainTheme,
    footerDataFixture({ getAvailableProviderCount: () => 1, ...data }),
  );
  if (!component.dispose) throw new Error("Expected a disposable footer.");
  return {
    render: (width: number) => component.render(width),
    dispose: () => component.dispose?.(),
  };
}

export const assistantMessage = (
  usage: AssistantMessage["usage"] = nativeUsage(0),
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "test",
  provider: "test",
  model: "test",
  usage,
  stopReason,
  timestamp: 0,
});

export type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
export const execResult = (stdout = "", code = 0): ExecResult => ({
  stdout,
  stderr: "",
  code,
  killed: false,
  truncated: false,
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
