import * as Predicate from "effect/Predicate";
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as MutableRef from "effect/MutableRef";
import { CosmicUiConfigStore, CosmicUiConfigError } from "../src/config/store.ts";
import { makeDefaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { CosmicUiService, type CosmicUiProjection } from "../src/protocol/service.ts";
import { vi } from "vitest";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import cosmicUi from "../index.ts";
import type { CosmicUiApplicationDependencies } from "../src/application.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicUiHostStateEvent,
} from "../src/protocol/protocol.ts";
import { abortablePendingExec, eventBus, execOk, execResult } from "./support/host.ts";

type Handler = ExtensionHandler<any, any>;

function harness(mode: "tui" | "rpc" = "tui", dependencies?: CosmicUiApplicationDependencies) {
  const handlers = new Map<string, Handler[]>();
  const setFooter = vi.fn();
  const setWorkingMessage = vi.fn();
  const unsubscribed = vi.fn();
  const exec = vi.fn((command: string, args: string[], _options?: { signal?: AbortSignal }) =>
    execOk(
      command === "gh"
        ? "42\n"
        : args.includes("diff")
          ? "10\t4\tchanged.ts\n"
          : "## main...origin/main\n M changed.ts\n?? new.ts\n",
    ),
  );
  const pi = extensionApiFixture({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
    getThinkingLevel: vi.fn(() => "high"),
    exec,
    events: eventBus(unsubscribed).events,
  });
  const ctx = extensionContextFixture({
    cwd: process.cwd(),
    mode,
    hasUI: true,
    model: { id: "model-long-name", provider: "provider", reasoning: true, contextWindow: 100_000 },
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    getContextUsage: vi.fn(() => ({ contextWindow: 100_000, tokens: 12_500, percent: 12.5 })),
    sessionManager: {
      getEntries: vi.fn(() => assistantEntries()),
      getCwd: vi.fn(() => "/tmp/project"),
      getSessionName: vi.fn(() => "session"),
      getLeafId: vi.fn(() => "leaf"),
    },
    ui: { setFooter, setWorkingMessage, notify: vi.fn(), custom: vi.fn() },
    isProjectTrusted: vi.fn(() => true),
  });
  cosmicUi(pi, dependencies);
  return { pi, ctx, handlers, setFooter, setWorkingMessage, exec, unsubscribed };
}

function emit<EventInput>(
  h: ReturnType<typeof harness>,
  name: string,
  event?: EventInput,
  context: ExtensionContext = h.ctx,
): Effect.Effect<void> {
  return Effect.forEach(
    h.handlers.get(name) ?? [],
    (handler) => Effect.promise(() => Promise.resolve(handler(event ?? {}, context))),
    { discard: true },
  );
}

const waitUntil = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.promise(() =>
    vi.waitFor(
      () => {
        if (!predicate()) throw new Error("condition did not become true");
      },
      { timeout: 1_000, interval: 1 },
    ),
  );

type FooterData = Parameters<NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>>[2];

function footerData(overrides: Partial<FooterData> = {}): FooterData {
  return {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map(),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => vi.fn(),
    ...overrides,
  };
}

function makeFooter(
  factory: (
    tui: { requestRender(): void },
    theme: { fg(color: string, text: string): string },
    data: FooterData,
  ) => { render(width: number): string[]; dispose(): void },
  data: Partial<FooterData> = {},
  requestRender: () => void = vi.fn(),
) {
  return factory({ requestRender }, { fg: (_color, text) => text }, footerData(data));
}

function capturedFooter(
  h: ReturnType<typeof harness>,
  call = 0,
  data: Partial<FooterData> = {},
  requestRender?: () => void,
) {
  return makeFooter(h.setFooter.mock.calls.at(call)?.[0], data, requestRender);
}

const expectFooterShows = (footer: { render(width: number): string[] }, ...values: string[]) => {
  const rendered = footer.render(100).join("\n");
  for (const value of values) expect(rendered).toContain(value);
};

/** A replacement context for the same host with overridden session-manager members. */
const withSession = (
  base: ExtensionContext,
  session: Partial<ExtensionContext["sessionManager"]>,
  extra: Partial<ExtensionContext> = {},
) =>
  extensionContextFixture({
    ...base,
    ...extra,
    sessionManager: { ...base.sessionManager, ...session },
  });

const assistantUsage = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: 0 },
});

function assistantEntries(
  ...inputs: number[]
): ReturnType<ExtensionContext["sessionManager"]["getEntries"]> {
  // SAFETY: These entries exercise only assistant usage aggregation.
  return inputs.map((input) => ({
    type: "message",
    message: { role: "assistant", usage: assistantUsage(input) },
  })) as never;
}

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
const entryBase = { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z" };
const nativeUsage = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const usageEntry = (kind: string, input: number) => ({
  ...entryBase,
  type: "usage" as const,
  kind,
  provider: "test",
  model: "test",
  usage: nativeUsage(input),
});

function capturedSignal(source = new AbortController().signal, onAbortedRead = () => {}) {
  const addEventListener = vi.fn(source.addEventListener.bind(source));
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

/** Forks session_start with host probes that stay pending until their signal aborts. */
const startWithPendingProbes = (h: ReturnType<typeof harness>) =>
  Effect.gen(function* () {
    let started = 0;
    let aborted = 0;
    h.exec.mockImplementation((_command, _args, options) => {
      started++;
      return abortablePendingExec(options?.signal, () => {
        aborted++;
      });
    });
    const startup = yield* emit(h, "session_start").pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* waitUntil(() => started === 2);
    return { startup, aborted: () => aborted };
  });

describe("Cosmic UI extension", () => {
  it.effect(
    "a retired masked config commit cannot republish after replacement initialization fails",
    () =>
      Effect.gen(function* () {
        const committed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let failed = false;
        let durable = makeDefaultResolvedCosmicUiConfig();
        let observed: MutableRef.MutableRef<CosmicUiProjection> | undefined;
        const projection = () => observed;
        const store = CosmicUiConfigStore.of({
          resolve: () =>
            failed
              ? Effect.fail(
                  new CosmicUiConfigError({
                    operation: "read",
                    path: "test",
                    message: "unavailable",
                  }),
                )
              : Effect.succeed(durable),
          updateFooter: () => Effect.die("unexpected footer update"),
          setVisibility: (_cwd, id, visible, _trusted, afterCommit) =>
            Effect.gen(function* () {
              const next = {
                ...durable,
                footer: { ...durable.footer, hidden: visible ? [] : [id] },
              };
              yield* Effect.sync(() => {
                durable = next;
              });
              yield* Deferred.succeed(committed, undefined);
              yield* Deferred.await(release);
              yield* afterCommit?.(next) ?? Effect.void;
              return next;
            }).pipe(Effect.uninterruptible),
        });
        const makeService = CosmicUiService.make;
        const boundary = vi.spyOn(CosmicUiService, "make").mockImplementation((options) => {
          observed = options.projection;
          return makeService({ ...options, startPolling: false }).pipe(
            Effect.provideService(CosmicUiConfigStore, store),
          );
        });
        const h = harness();
        try {
          yield* emit(h, "session_start");
          const command = h.pi.registerCommand.mock.calls.find(
            ([name]) => name === "cosmic-ui",
          )?.[1].handler;
          expect(command).toBeDefined();
          const pending = command?.("settings visible:openai.usage hidden", h.ctx);
          yield* Deferred.await(committed);
          h.ctx.ui.notify.mockClear();
          failed = true;
          const replacement = yield* emit(h, "session_start", {}, withSession(h.ctx, {})).pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.succeed(release, undefined);
          yield* Effect.promise(() => Promise.resolve(pending));
          yield* Fiber.join(replacement);
          expect(durable.footer.hidden).toEqual(["openai.usage"]);
          const retired = projection();
          expect(retired).toBeDefined();
          expect(retired && MutableRef.get(retired).config).toBeUndefined();
          expect(h.ctx.ui.notify).toHaveBeenCalledOnce(); // Only the current startup failure.
        } finally {
          yield* Deferred.succeed(release, undefined);
          yield* emit(h, "session_shutdown");
          boundary.mockRestore();
        }
      }),
  );

  it.effect("normalizes hostile protocol getters once and isolates throwing reads", () =>
    Effect.gen(function* () {
      const h = harness();
      const respond = vi.fn();
      const stateful = <A>(value: A) => {
        let reads = 0;
        return () => {
          reads++;
          if (reads > 1) throw new Error("protocol getter reread");
          return value;
        };
      };
      const queryRespond = stateful(respond);
      const upsertOwner = stateful("owner");
      const contribution = stateful({
        kind: "text",
        id: "hostile",
        region: "details",
        text: "hostile-text",
      });
      const invalidateOwner = stateful("owner");
      const removeId = stateful("hostile");

      expect(() =>
        h.pi.events.emit(COSMIC_UI_HOST_QUERY, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          get respond() {
            return queryRespond();
          },
        }),
      ).not.toThrow();
      expect(respond).toHaveBeenCalledOnce();
      expect(() =>
        h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          get owner() {
            return upsertOwner();
          },
          get contribution() {
            return contribution();
          },
        }),
      ).not.toThrow();
      yield* emit(h, "session_start");
      const requestRender = vi.fn();
      const footer = capturedFooter(h, 0, {}, requestRender);
      const shows = () => footer.render(100).join("\n").includes("hostile-text");
      yield* waitUntil(shows);
      requestRender.mockClear();
      expect(() =>
        h.pi.events.emit(COSMIC_UI_FOOTER_INVALIDATE, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          get owner() {
            return invalidateOwner();
          },
          id: "hostile",
        }),
      ).not.toThrow();
      yield* waitUntil(() => requestRender.mock.calls.length > 0);
      expect(() =>
        h.pi.events.emit(COSMIC_UI_FOOTER_REMOVE, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          owner: "owner",
          get id() {
            return removeId();
          },
        }),
      ).not.toThrow();
      yield* waitUntil(() => !shows());
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("reports live custom-footer ownership through host discovery", () =>
    Effect.gen(function* () {
      const h = harness();
      const broadcasts: boolean[] = [];
      h.pi.events.on(COSMIC_UI_HOST_STATE, (data) => {
        // SAFETY: This listener is registered only for Cosmic UI's typed host-state event.
        broadcasts.push((data as CosmicUiHostStateEvent).active);
      });
      let response: { readonly active: boolean } | undefined;
      const query = () => {
        response = undefined;
        h.pi.events.emit(COSMIC_UI_HOST_QUERY, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          respond: (state?: { readonly active: boolean }) => {
            response = state;
          },
        });
        return response;
      };

      expect(query()).toEqual({ active: false, ready: false, hidden: [] });
      yield* emit(h, "session_start");
      expect(query()).toEqual({ active: true, ready: true, hidden: [] });
      yield* emit(h, "session_shutdown");
      expect(query()).toBeUndefined();
      expect(broadcasts).toContain(true);
      expect(broadcasts.at(-1)).toBe(false);
    }),
  );

  it.effect("reinstalls the footer when session_start supplies a new context", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      const secondContext = withSession(
        h.ctx,
        { getCwd: () => "/tmp/second-project", getSessionName: () => "second-session" },
        { model: { ...h.ctx.model!, id: "second-model" } },
      );
      yield* emit(h, "session_start", {}, secondContext);

      expect(h.setFooter).toHaveBeenNthCalledWith(2, undefined);
      expect(h.setFooter).toHaveBeenCalledTimes(3);
      const footer = capturedFooter(h, 2);
      expectFooterShows(footer, "second-model", "/tmp/second-project", "second-session");

      const laterContext = withSession(
        secondContext,
        { getCwd: () => "/tmp/later-project", getSessionName: () => "later-session" },
        { model: { ...secondContext.model!, id: "later-model" } },
      );
      yield* emit(h, "model_select", {}, laterContext);
      expectFooterShows(footer, "later-model", "/tmp/later-project", "later-session");
    }),
  );

  it.effect(
    "immediately disposes in-flight startup probes on overlapping session replacement",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const { startup: first, aborted } = yield* startWithPendingProbes(h);
        h.exec.mockImplementation((command) => execOk(command === "gh" ? "7\n" : "## current\n"));
        const secondContext = withSession(h.ctx, {
          getCwd: () => "/tmp/replacement",
          getSessionName: () => "replacement",
        });
        const second = Promise.all(
          (h.handlers.get("session_start") ?? []).map((handler) => handler({}, secondContext)),
        );
        yield* Fiber.join(first);
        yield* Effect.promise(() => second);
        expect(aborted()).toBe(2);
        expect(h.setFooter).toHaveBeenNthCalledWith(2, undefined);
        const footer = capturedFooter(h, -1);
        expect(footer.render(100).join("\n")).toContain("/tmp/replacement");
      }),
  );

  it.effect(
    "shutdown during startup survives throwing render requests and releases every probe",
    () =>
      Effect.gen(function* () {
        const h = harness();
        h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          owner: "pending",
          contribution: { kind: "text", id: "pending", region: "details", text: "pending-text" },
        });
        const { startup, aborted } = yield* startWithPendingProbes(h);
        const requestRender = vi.fn(() => {
          throw new Error("render");
        });
        const footer = capturedFooter(h, 0, {}, requestRender);
        expect(footer.render(100).join("\n")).toContain("pending-text");
        const shutdown = yield* emit(h, "session_shutdown").pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Fiber.join(startup);
        yield* Fiber.join(shutdown);
        expect(aborted()).toBe(2);
        expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
      }),
  );

  it.effect("reports startup I/O failure and permits a clean subsequent session", () =>
    Effect.gen(function* () {
      const h = harness();
      const { signal, addEventListener, removeEventListener } = capturedSignal();
      h.ctx.signal = signal;
      h.ctx.cwd = "\0invalid";
      yield* emit(h, "session_start");
      expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
      expect(h.setFooter).not.toHaveBeenCalled();
      expect(removeEventListener).toHaveBeenCalledOnce();

      h.ctx.cwd = process.cwd();
      yield* emit(h, "session_start");
      expect(h.setFooter).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledTimes(2);
      yield* emit(h, "session_shutdown");
      expect(removeEventListener).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("keeps a pre-session contribution through a failed start", () =>
    Effect.gen(function* () {
      const h = harness();
      h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        owner: "early",
        contribution: { kind: "text", id: "early", region: "details", text: "early-text" },
      });
      h.ctx.cwd = "\0invalid";
      yield* emit(h, "session_start");
      expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");

      h.ctx.cwd = process.cwd();
      yield* emit(h, "session_start");
      expectFooterShows(capturedFooter(h), "early-text");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("retries footer installation after the host rejects the first setFooter call", () =>
    Effect.gen(function* () {
      const h = harness();
      h.setFooter.mockImplementationOnce(() => {
        throw new Error("host rejected footer");
      });

      yield* emit(h, "session_start");
      expect(h.setFooter).toHaveBeenCalledOnce();

      yield* emit(h, "session_start");
      expect(h.setFooter).toHaveBeenCalledTimes(2);
      expect(h.setFooter.mock.calls[1]?.[0]).toEqual(expect.any(Function));

      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect(
    "retains complete same-session totals but resets them before a failing new session",
    () =>
      Effect.gen(function* () {
        const h = harness();
        let reads = 0;
        h.ctx.sessionManager.getEntries = vi.fn(() => {
          reads++;
          if (reads > 1) throw new Error("one-shot entries");
          return assistantEntries(100);
        });
        yield* emit(h, "session_start");
        const firstFooter = capturedFooter(h);
        expect(firstFooter.render(100).join("\n")).toContain("↑100");

        yield* emit(h, "session_compact");
        expect(reads).toBe(2);
        expect(firstFooter.render(100).join("\n")).toContain("↑100");

        const secondContext = withSession(h.ctx, {
          getEntries: () => {
            throw new Error("new session entries unavailable");
          },
        });
        yield* emit(h, "session_start", {}, secondContext);
        const secondFooter = capturedFooter(h, -1);
        expect(secondFooter.render(100).join("\n")).not.toContain("↑100");
        h.ctx.sessionManager.getEntries = vi.fn(() => assistantEntries(900));
        yield* emit(h, "message_start", {}, h.ctx);
        yield* emit(h, "turn_end", {}, h.ctx);
        yield* emit(h, "agent_settled", {}, h.ctx);
        expect(secondFooter.render(100).join("\n")).not.toContain("↑900");
        yield* emit(h, "session_shutdown");
      }),
  );

  it.live("refreshes idle persisted warming usage through the existing ticker", () => {
    const h = harness();
    return Effect.gen(function* () {
      const entries = assistantEntries(10);
      h.ctx.sessionManager.getEntries = vi.fn(() => entries);
      yield* emit(h, "session_start");
      const footer = capturedFooter(h);
      entries.push(
        {
          ...entryBase,
          type: "custom",
          customType: "cache_warming_decision",
          data: { estimatedInput: 999 },
        },
        usageEntry("cache_warm", 90),
      );
      yield* Effect.promise(() =>
        vi.waitFor(
          () => {
            expect(footer.render(100).join("\n")).toContain("↑100");
          },
          { timeout: 2500, interval: 10 },
        ),
      );
    }).pipe(Effect.ensuring(emit(h, "session_shutdown")));
  });

  it.effect("reconciles persisted usage without reading or double charging event usage", () =>
    Effect.gen(function* () {
      const h = harness();
      const usage = nativeUsage(10);
      const entries: SessionEntries = [
        ...assistantEntries(50),
        usageEntry("future-operation", 10),
        {
          ...entryBase,
          type: "compaction",
          summary: "summary",
          firstKeptEntryId: "entry",
          tokensBefore: 50,
          usage,
        },
        { ...entryBase, type: "branch_summary", fromId: "entry", summary: "summary", usage },
        {
          ...entryBase,
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call",
            toolName: "nested",
            content: [],
            isError: false,
            timestamp: 0,
            usage,
          },
        },
      ];
      h.ctx.sessionManager.getEntries = vi.fn(() => entries);
      yield* emit(h, "session_start");
      const footer = capturedFooter(h);
      expect(footer.render(100).join("\n")).toContain("↑90");
      const input = vi.fn(() => {
        throw new Error("nested usage failure");
      });
      const hostileUsage = Object.defineProperty({ ...usage }, "input", { get: input });
      yield* emit(h, "message_end", { message: { role: "assistant", usage: hostileUsage } });
      yield* emit(h, "turn_end", { message: { role: "assistant", usage } });
      yield* emit(h, "agent_settled");
      expect(input).not.toHaveBeenCalled();
      expect(footer.render(100).join("\n")).toContain("↑90");
      entries.push(usageEntry("cache_warm", 10));
      yield* emit(h, "agent_settled");
      expect(footer.render(100).join("\n")).toContain("↑100");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("retains the last complete totals when numeric decoding rejects a rescan", () =>
    Effect.gen(function* () {
      const h = harness();
      const initialEntries = vi.fn(() => assistantEntries(50));
      h.ctx.sessionManager.getEntries = initialEntries;
      yield* emit(h, "session_start");
      const footer = capturedFooter(h);
      expect(footer.render(100).join("\n")).toContain("↑50");

      // A partially valid rescan is discarded atomically when a later record is invalid.
      const rescannedEntries = vi.fn(() => assistantEntries(25, Number.NaN));
      h.ctx.sessionManager.getEntries = rescannedEntries;
      yield* emit(h, "session_compact");
      expect(footer.render(100).join("\n")).toContain("↑50");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("fails closed when the live context mode getter throws", () =>
    Effect.gen(function* () {
      const h = harness();
      Object.defineProperty(h.ctx, "mode", {
        get() {
          throw new Error("mode host failure");
        },
      });
      yield* emit(h, "session_start");
      expect(h.setFooter).not.toHaveBeenCalled();
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("materializes session cwd, signal, and initial abort state exactly once", () =>
    Effect.gen(function* () {
      const h = harness();
      let cwdReads = 0;
      let signalReads = 0;
      let abortedReads = 0;
      const { signal, addEventListener, removeEventListener } = capturedSignal(undefined, () => {
        abortedReads++;
      });
      Object.defineProperties(h.ctx, {
        cwd: {
          get() {
            cwdReads++;
            if (cwdReads > 1) throw new Error("cwd reread");
            return process.cwd();
          },
        },
        signal: {
          get() {
            signalReads++;
            if (signalReads > 1) throw new Error("signal reread");
            return signal;
          },
        },
      });

      yield* emit(h, "session_start");
      expect(cwdReads).toBe(1);
      expect(signalReads).toBe(1);
      expect(abortedReads).toBe(1);
      expect(addEventListener).toHaveBeenCalledOnce();
      expect(h.setFooter).toHaveBeenCalledOnce();
      yield* emit(h, "session_shutdown");
      expect(removeEventListener).toHaveBeenCalledOnce();
    }),
  );

  it.effect("observes an abort between session capture and runtime listener registration", () =>
    Effect.gen(function* () {
      const h = harness();
      const controller = new AbortController();
      const { signal, addEventListener, removeEventListener } = capturedSignal(controller.signal);
      h.ctx.signal = signal;
      h.ctx.isProjectTrusted = vi.fn(() => {
        controller.abort();
        return true;
      });

      yield* emit(h, "session_start");

      expect(addEventListener).toHaveBeenCalledOnce();
      expect(removeEventListener).toHaveBeenCalledOnce();
      expect(h.setFooter).not.toHaveBeenCalled();
      expect(h.exec).not.toHaveBeenCalled();
    }),
  );

  it.effect("releases short-lived event abort forwarders when runtime work settles", () =>
    Effect.gen(function* () {
      const h = harness();
      const { signal, addEventListener, removeEventListener } = capturedSignal();
      h.ctx.signal = signal;

      yield* emit(h, "session_start");
      expect(addEventListener).toHaveBeenCalledTimes(1);
      expect(removeEventListener).not.toHaveBeenCalled();

      yield* emit(h, "turn_end");
      expect(addEventListener).toHaveBeenCalledTimes(2);
      expect(removeEventListener).toHaveBeenCalledOnce();

      yield* emit(h, "session_shutdown");
      expect(removeEventListener).toHaveBeenCalledTimes(2);
    }),
  );

  for (const property of ["signal", "cwd"] as const) {
    it.effect(`shuts down the prior session when the next session ${property} getter throws`, () =>
      Effect.gen(function* () {
        const h = harness();
        yield* emit(h, "session_start");
        const hostile = extensionContextFixture({ ...h.ctx });
        Object.defineProperty(hostile, property, {
          get() {
            throw new Error(`${property} host failure`);
          },
        });

        yield* emit(h, "session_start", {}, hostile);
        expect(h.setFooter).toHaveBeenCalledTimes(2);
        expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
        yield* emit(h, "session_shutdown");
      }),
    );
  }

  it.effect("contains delayed branch subscription creation and lifecycle failures", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      let branchChanged: (() => void) | undefined;
      const unsubscribe = vi.fn(() => {
        throw new Error("unsubscribe host failure");
      });
      const footer = capturedFooter(
        h,
        0,
        {
          onBranchChange(callback: () => void) {
            branchChanged = callback;
            return unsubscribe;
          },
        },
        () => {
          throw new Error("render host failure");
        },
      );

      expect(() => branchChanged?.()).not.toThrow();
      expect(() => footer.dispose()).not.toThrow();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(() =>
        capturedFooter(h, 0, {
          onBranchChange() {
            throw new Error("subscription host failure");
          },
        }),
      ).not.toThrow();
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("stale failed-factory disposal cannot clear a successful retry", () =>
    Effect.gen(function* () {
      const h = harness();
      let staleFooter: { dispose(): void } | undefined;
      let activeFooter: { dispose(): void } | undefined;
      const staleUnsubscribe = vi.fn();
      h.setFooter
        .mockImplementationOnce((factory) => {
          staleFooter = makeFooter(factory, { onBranchChange: () => staleUnsubscribe });
          throw new Error("setFooter failed after factory creation");
        })
        .mockImplementationOnce((factory) => {
          const unsubscribe = vi.fn();
          activeFooter = makeFooter(factory, { onBranchChange: () => unsubscribe });
        });

      yield* emit(h, "session_start");
      expect(staleUnsubscribe).toHaveBeenCalledOnce();
      yield* emit(h, "session_start");
      expect(activeFooter).toBeDefined();

      staleFooter?.dispose();
      expect(staleUnsubscribe).toHaveBeenCalledOnce();
      yield* emit(h, "session_shutdown");
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    }),
  );

  it.effect("an older instance cannot dispose a newer footer from the same factory", () =>
    Effect.gen(function* () {
      const h = harness();
      const firstUnsubscribe = vi.fn();
      const secondUnsubscribe = vi.fn();
      yield* emit(h, "session_start");
      const first = capturedFooter(h, 0, { onBranchChange: () => firstUnsubscribe });
      capturedFooter(h, 0, { onBranchChange: () => secondUnsubscribe });

      first.dispose();
      expect(firstUnsubscribe).toHaveBeenCalledOnce();
      expect(secondUnsubscribe).not.toHaveBeenCalled();
      yield* emit(h, "session_shutdown");
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
      expect(secondUnsubscribe).toHaveBeenCalledOnce();
    }),
  );

  it.effect("retries footer removal after the host rejects a pre-disposal clear", () =>
    Effect.gen(function* () {
      const h = harness();
      let removalAttempts = 0;
      h.setFooter.mockImplementation((factory) => {
        if (factory !== undefined) return;
        removalAttempts++;
        if (removalAttempts === 1) throw new Error("footer still installed");
      });

      yield* emit(h, "session_start");
      yield* emit(h, "session_shutdown");

      expect(removalAttempts).toBe(2);
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    }),
  );

  it.effect("relinquishes footer ownership when the host disposes before rejecting removal", () =>
    Effect.gen(function* () {
      const h = harness();
      const unsubscribe = vi.fn();
      let installedFooter: { dispose(): void } | undefined;
      let removalAttempts = 0;
      h.setFooter.mockImplementation((factory) => {
        if (factory !== undefined) {
          installedFooter = makeFooter(factory, { onBranchChange: () => unsubscribe });
          return;
        }
        removalAttempts++;
        installedFooter?.dispose();
        throw new Error("host rejected removal after disposal");
      });

      yield* emit(h, "session_start");
      yield* emit(h, "session_shutdown");
      expect(removalAttempts).toBe(1);
      expect(unsubscribe).toHaveBeenCalledOnce();

      yield* emit(h, "session_start");
      expect(h.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("treats duplicate agent starts as idempotent while a prompt is open", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      yield* emit(h, "agent_start");
      yield* emit(h, "ui_prompt_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Waiting for you");

      yield* emit(h, "agent_start");
      yield* emit(h, "ui_prompt_end");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");
      yield* emit(h, "agent_end");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("a prompt end admitted by a replaced session cannot resume the new timer", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      yield* emit(h, "agent_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");
      yield* emit(h, "ui_prompt_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Waiting for you");

      const replacement = withSession(h.ctx, {
        getCwd: () => "/tmp/replacement",
        getSessionName: () => "replacement",
      });
      yield* emit(h, "session_start", {}, replacement);
      yield* emit(h, "agent_start", {}, replacement);
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");

      const writesBeforeStaleEnd = h.setWorkingMessage.mock.calls.length;
      yield* emit(h, "ui_prompt_end", {}, replacement);
      yield* Effect.yieldNow;
      expect(h.setWorkingMessage).toHaveBeenCalledTimes(writesBeforeStaleEnd);

      yield* emit(h, "ui_prompt_start", {}, replacement);
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Waiting for you");
      yield* emit(h, "ui_prompt_end", {}, replacement);
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("agent settlement clears prompt ownership before the next run", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      yield* emit(h, "agent_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");
      yield* emit(h, "ui_prompt_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Waiting for you");

      yield* emit(h, "agent_end");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === undefined);
      yield* emit(h, "agent_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");

      const writesBeforeStaleEnd = h.setWorkingMessage.mock.calls.length;
      yield* emit(h, "ui_prompt_end");
      yield* Effect.yieldNow;
      expect(h.setWorkingMessage).toHaveBeenCalledTimes(writesBeforeStaleEnd);
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("a prompt followed immediately by agent settlement leaves the host cleared", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      yield* emit(h, "agent_start");
      yield* emit(h, "ui_prompt_start");
      yield* emit(h, "agent_end");

      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === undefined);
      const writesAfterSettlement = h.setWorkingMessage.mock.calls.length;
      yield* Effect.yieldNow;
      expect(h.setWorkingMessage).toHaveBeenCalledTimes(writesAfterSettlement);
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("session abort clears a running working row", () => {
    const h = harness();
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    return Effect.gen(function* () {
      yield* emit(h, "session_start");
      yield* emit(h, "agent_start");
      expect(h.setWorkingMessage).toHaveBeenLastCalledWith("Working · 0s");

      controller.abort();
      expect(h.setWorkingMessage).toHaveBeenLastCalledWith(undefined);
    });
  });

  it.effect("session abort interrupts startup probes without waiting for them", () =>
    Effect.gen(function* () {
      const h = harness();
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      const { startup, aborted } = yield* startWithPendingProbes(h);
      controller.abort();
      yield* Fiber.join(startup);
      yield* waitUntil(() => aborted() === 2);
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    }),
  );

  it.effect("polls git status so external commits and edits refresh automatically", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      try {
        const h = harness();
        yield* emit(h, "session_start");
        expect(h.exec).toHaveBeenCalledTimes(3);
        const footer = capturedFooter(h, 0, { getGitBranch: () => "main" });
        h.exec.mockResolvedValueOnce(execResult("## main...origin/main\n"));

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(h.exec).toHaveBeenCalledTimes(4);
        const cleanFooter = footer.render(100).join("\n");
        expect(cleanFooter).not.toContain("clean");
        expect(cleanFooter).not.toContain("~1 ?1");

        yield* emit(h, "session_shutdown");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(h.exec).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    }),
  );

  it.effect("session abort removes the footer and interrupts the active runtime", () =>
    Effect.gen(function* () {
      const h = harness();
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      yield* emit(h, "session_start");
      controller.abort();
      yield* Effect.promise(() => Promise.resolve());
      yield* Effect.promise(() => Promise.resolve());
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    }),
  );

  it.effect("awaits shared ticker cleanup during session shutdown", () => {
    const finishTickerShutdown = Deferred.makeUnsafe<void>();
    const tickerShutdown = Effect.runPromise(Deferred.await(finishTickerShutdown));
    const shutdownHostUiTickers = vi.fn(() => tickerShutdown);
    const h = harness("tui", { shutdownHostUiTickers });
    return Effect.gen(function* () {
      yield* emit(h, "session_start");

      let settled = false;
      const shutdown = yield* emit(h, "session_shutdown").pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Effect.promise(() => Promise.resolve());
      expect(shutdownHostUiTickers).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      yield* emit(h, "session_start");
      const footer = capturedFooter(h, -1);
      const replacementState = footer.render(100);
      yield* Deferred.succeed(finishTickerShutdown, undefined);
      yield* Fiber.join(shutdown);
      expect(settled).toBe(true);
      expect(footer.render(100)).toEqual(replacementState);
      yield* emit(h, "session_shutdown");
    });
  });

  it.effect("releases protocol subscriptions exactly once on repeated shutdown", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      yield* emit(h, "session_shutdown");
      yield* emit(h, "session_shutdown");
      expect(h.unsubscribed).toHaveBeenCalledTimes(4);
    }),
  );
});
