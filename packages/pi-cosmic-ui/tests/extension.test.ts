import * as Predicate from "effect/Predicate";
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";
import cosmicUi from "../index.ts";
import {
  cosmicUiWithDependencies,
  type CosmicUiApplicationDependencies,
} from "../src/application.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_PROTOCOL_VERSION,
} from "../src/protocol/protocol.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

type Handler = ExtensionHandler<any, any>;
type BusHandler = Parameters<ExtensionAPI["events"]["on"]>[1];

function harness(mode: "tui" | "rpc" = "tui", dependencies?: CosmicUiApplicationDependencies) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Set<BusHandler>>();
  const setFooter = vi.fn();
  const setWorkingMessage = vi.fn();
  const unsubscribed = vi.fn();
  const exec = vi.fn((command: string, args: string[], _options?: { signal?: AbortSignal }) =>
    Promise.resolve({
      stdout:
        command === "gh"
          ? "42\n"
          : args.includes("diff")
            ? "10\t4\tchanged.ts\n"
            : "## main...origin/main\n M changed.ts\n?? new.ts\n",
      stderr: "",
      code: 0,
      killed: false,
    }),
  );
  const pi = extensionApiFixture({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
    getThinkingLevel: vi.fn(() => "high"),
    exec,
    events: {
      emit<DataInput>(name: string, data: DataInput) {
        for (const handler of bus.get(name) ?? []) handler(data);
      },
      on(name: string, handler: BusHandler) {
        const entries = bus.get(name) ?? new Set();
        entries.add(handler);
        bus.set(name, entries);
        return () => {
          entries.delete(handler);
          unsubscribed(name);
        };
      },
    },
  });
  const ctx = extensionContextFixture({
    cwd: process.cwd(),
    mode,
    hasUI: true,
    model: { id: "model-long-name", provider: "provider", reasoning: true, contextWindow: 100_000 },
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    getContextUsage: vi.fn(() => ({ contextWindow: 100_000, tokens: 12_500, percent: 12.5 })),
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => "/tmp/project"),
      getSessionName: vi.fn(() => "session"),
      getLeafId: vi.fn(() => "leaf"),
    },
    ui: { setFooter, setWorkingMessage, notify: vi.fn(), custom: vi.fn() },
    isProjectTrusted: vi.fn(() => true),
  });
  if (dependencies) cosmicUiWithDependencies(pi, dependencies);
  else cosmicUi(pi);
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

type ExecResult = Awaited<ReturnType<ReturnType<typeof harness>["exec"]>>;

function installPendingExec(h: ReturnType<typeof harness>) {
  let started = 0;
  let aborted = 0;
  h.exec.mockImplementation(
    (_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
      started++;
      // Deferred-backed pending host exec promise that rejects when the probe aborts.
      const handle = Deferred.makeUnsafe<ExecResult, Error>();
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted++;
          Effect.runSync(Deferred.fail(handle, new Error("aborted")));
        },
        { once: true },
      );
      return Effect.runPromise(Deferred.await(handle));
    },
  );
  return { started: () => started, aborted: () => aborted };
}

const successfulExec = (command: string) =>
  Promise.resolve({
    stdout: command === "gh" ? "7\n" : "## current\n",
    stderr: "",
    code: 0,
    killed: false,
  });

describe("Cosmic UI extension", () => {
  it.effect("normalizes hostile protocol getters once and isolates throwing reads", () =>
    Effect.gen(function* () {
      const h = harness();
      const respond = vi.fn();
      const invalidate = vi.fn();
      const dispose = vi.fn();
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
        kind: "surface",
        id: "surface",
        region: "media",
        preferredWidth: 8,
        render: () => [],
        invalidate,
        dispose,
      });
      const invalidateOwner = stateful("owner");
      const removeId = stateful("surface");

      expect(() =>
        h.pi.events.emit(COSMIC_UI_HOST_QUERY, {
          version: 1,
          get respond() {
            return queryRespond();
          },
        }),
      ).not.toThrow();
      expect(respond).toHaveBeenCalledOnce();
      expect(() =>
        h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
          version: 1,
          get owner() {
            return upsertOwner();
          },
          get contribution() {
            return contribution();
          },
        }),
      ).not.toThrow();
      yield* emit(h, "session_start");
      expect(() =>
        h.pi.events.emit(COSMIC_UI_FOOTER_INVALIDATE, {
          version: 1,
          get owner() {
            return invalidateOwner();
          },
          id: "surface",
        }),
      ).not.toThrow();
      yield* waitUntil(() => invalidate.mock.calls.length === 1);
      expect(() =>
        h.pi.events.emit(COSMIC_UI_FOOTER_REMOVE, {
          version: 1,
          owner: "owner",
          get id() {
            return removeId();
          },
        }),
      ).not.toThrow();
      yield* waitUntil(() => dispose.mock.calls.length === 1);

      const throwing = Object.defineProperty({}, "version", {
        get() {
          throw new Error("secret hostile getter");
        },
      });
      for (const eventName of [
        COSMIC_UI_HOST_QUERY,
        COSMIC_UI_FOOTER_UPSERT,
        COSMIC_UI_FOOTER_REMOVE,
        COSMIC_UI_FOOTER_INVALIDATE,
      ])
        expect(() => h.pi.events.emit(eventName, throwing)).not.toThrow();
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("reinstalls the footer when session_start supplies a new context", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const secondContext = {
        ...h.ctx,
        model: { ...h.ctx.model!, id: "second-model" },
        sessionManager: {
          ...h.ctx.sessionManager,
          getEntries: vi.fn(() => []),
          getCwd: vi.fn(() => "/tmp/second-project"),
          getSessionName: vi.fn(() => "second-session"),
          getLeafId: vi.fn(() => "second-leaf"),
        },
      } as ExtensionContext;
      yield* emit(h, "session_start", {}, secondContext);

      expect(h.setFooter).toHaveBeenNthCalledWith(2, undefined);
      expect(h.setFooter).toHaveBeenCalledTimes(3);
      const factory = h.setFooter.mock.calls[2]?.[0];
      const footer = factory(
        { requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text },
        {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          getAvailableProviderCount: () => 1,
          onBranchChange: () => vi.fn(),
        },
      );
      const rendered = footer.render(100);
      expect(rendered[0]).toBe("Model   second-model • high");
      expect(rendered[1]).toContain("Repo    /tmp/second-project");
      expect(rendered.join("\n")).toContain("second-session");

      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const laterContext = {
        ...secondContext,
        model: { ...secondContext.model!, id: "later-model" },
        sessionManager: {
          ...secondContext.sessionManager,
          getCwd: vi.fn(() => "/tmp/later-project"),
          getSessionName: vi.fn(() => "later-session"),
          getLeafId: vi.fn(() => "later-leaf"),
        },
      } as ExtensionContext;
      yield* emit(h, "model_select", {}, laterContext);
      const laterRendered = footer.render(100);
      expect(laterRendered[0]).toBe("Model   later-model • high");
      expect(laterRendered[1]).toContain("Repo    /tmp/later-project");
      expect(laterRendered.join("\n")).toContain("later-session");
    }),
  );

  it.effect(
    "immediately disposes in-flight startup probes on overlapping session replacement",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const pending = installPendingExec(h);
        const first = yield* emit(h, "session_start").pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* waitUntil(() => pending.started() === 2);

        h.exec.mockImplementation(successfulExec);
        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        const secondContext = {
          ...h.ctx,
          sessionManager: {
            ...h.ctx.sessionManager,
            getCwd: () => "/tmp/replacement",
            getSessionName: () => "replacement",
          },
        } as ExtensionContext;
        const second = Promise.all(
          (h.handlers.get("session_start") ?? []).map((handler) => handler({}, secondContext)),
        );
        yield* Fiber.join(first);
        yield* Effect.promise(() => second);
        expect(pending.aborted()).toBe(2);
        expect(h.setFooter).toHaveBeenNthCalledWith(2, undefined);
        const factory = h.setFooter.mock.calls.at(-1)?.[0];
        const footer = factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: () => vi.fn(),
          },
        );
        expect(footer.render(100).join("\n")).toContain("/tmp/replacement");
      }),
  );

  it.effect("shutdown during startup survives throwing surfaces and releases every probe", () =>
    Effect.gen(function* () {
      const h = harness();
      const callbacks = { attach: vi.fn(), detach: vi.fn(), dispose: vi.fn() };
      h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        owner: "hostile",
        contribution: {
          kind: "surface",
          id: "hostile",
          region: "media",
          preferredWidth: 8,
          render: () => [],
          attach: () => {
            callbacks.attach();
            throw new Error("attach");
          },
          detach: () => {
            callbacks.detach();
            throw new Error("detach");
          },
          dispose: () => {
            callbacks.dispose();
            throw new Error("dispose");
          },
        },
      });
      const pending = installPendingExec(h);
      const startup = yield* emit(h, "session_start").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* waitUntil(() => pending.started() === 2);
      const factory = h.setFooter.mock.calls[0]?.[0];
      expect(() =>
        factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: () => vi.fn(),
          },
        ),
      ).not.toThrow();
      const shutdown = yield* emit(h, "session_shutdown").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Fiber.join(startup);
      yield* Fiber.join(shutdown);
      expect(pending.aborted()).toBe(2);
      expect(callbacks.attach).toHaveBeenCalledOnce();
      expect(callbacks.detach).toHaveBeenCalledOnce();
      expect(callbacks.dispose).toHaveBeenCalledOnce();
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    }),
  );

  it.effect("reports startup I/O failure and permits a clean subsequent session", () =>
    Effect.gen(function* () {
      const h = harness();
      const source = new AbortController().signal;
      const addEventListener = vi.fn(source.addEventListener.bind(source));
      const removeEventListener = vi.fn(source.removeEventListener.bind(source));
      h.ctx.signal = new Proxy(source, {
        get(target, property) {
          if (property === "addEventListener") return addEventListener;
          if (property === "removeEventListener") return removeEventListener;
          // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
          const value = property in target ? target[property as keyof AbortSignal] : undefined;
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });
      h.ctx.cwd = "\0invalid";
      yield* emit(h, "session_start");
      expect(h.ctx.ui.notify).toHaveBeenCalledWith("Cosmic UI failed to start.", "warning");
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
          // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
          return [
            {
              type: "message",
              message: {
                role: "assistant",
                usage: {
                  input: 100,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0 },
                },
              },
            },
          ] as never;
        });
        yield* emit(h, "session_start");
        const firstFactory = h.setFooter.mock.calls[0]?.[0];
        const firstFooter = firstFactory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: () => vi.fn(),
          },
        );
        expect(firstFooter.render(100).join("\n")).toContain("↑100");

        yield* emit(h, "session_compact");
        expect(reads).toBe(2);
        expect(firstFooter.render(100).join("\n")).toContain("↑100");

        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        const secondContext = {
          ...h.ctx,
          sessionManager: {
            ...h.ctx.sessionManager,
            getEntries: vi.fn(() => {
              throw new Error("new session entries unavailable");
            }),
          },
        } as ExtensionContext;
        yield* emit(h, "session_start", {}, secondContext);
        const secondFactory = h.setFooter.mock.calls.at(-1)?.[0];
        const secondFooter = secondFactory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: () => vi.fn(),
          },
        );
        expect(secondFooter.render(100).join("\n")).not.toContain("↑100");
        yield* emit(h, "session_shutdown");
      }),
  );

  it.effect("retains complete totals when a turn usage getter throws", () =>
    Effect.gen(function* () {
      const h = harness();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      h.ctx.sessionManager.getEntries = vi.fn(
        () =>
          [
            {
              type: "message",
              message: {
                role: "assistant",
                usage: {
                  input: 50,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: { total: 0 },
                },
              },
            },
          ] as never,
      );
      yield* emit(h, "session_start");
      const factory = h.setFooter.mock.calls[0]?.[0];
      const footer = factory(
        { requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text },
        {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          getAvailableProviderCount: () => 1,
          onBranchChange: () => vi.fn(),
        },
      );
      const input = vi.fn(() => {
        throw new Error("nested usage failure");
      });
      const usage = Object.defineProperty(
        { output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        "input",
        { get: input },
      );

      yield* emit(h, "turn_end", { message: { role: "assistant", usage } });
      expect(input).toHaveBeenCalledOnce();
      expect(footer.render(100).join("\n")).toContain("↑50");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("retains the last complete totals when numeric decoding rejects a rescan or turn", () =>
    Effect.gen(function* () {
      const h = harness();
      const usage = (input: number) => ({
        input,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0 },
      });
      // SAFETY: These locally constructed session entries exercise only assistant usage aggregation.
      h.ctx.sessionManager.getEntries = vi.fn(
        () => [{ type: "message", message: { role: "assistant", usage: usage(50) } }] as never,
      );
      yield* emit(h, "session_start");
      const factory = h.setFooter.mock.calls[0]?.[0];
      const footer = factory(
        { requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text },
        {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          getAvailableProviderCount: () => 1,
          onBranchChange: () => vi.fn(),
        },
      );
      expect(footer.render(100).join("\n")).toContain("↑50");

      // A partially valid rescan is discarded atomically when a later record is invalid.
      // SAFETY: These locally constructed session entries exercise only assistant usage aggregation.
      h.ctx.sessionManager.getEntries = vi.fn(
        () =>
          [
            { type: "message", message: { role: "assistant", usage: usage(25) } },
            { type: "message", message: { role: "assistant", usage: usage(Number.NaN) } },
          ] as never,
      );
      yield* emit(h, "session_compact");
      expect(footer.render(100).join("\n")).toContain("↑50");

      yield* emit(h, "turn_end", {
        message: { role: "assistant", usage: usage(Number.POSITIVE_INFINITY) },
      });
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
      const source = new AbortController().signal;
      let cwdReads = 0;
      let signalReads = 0;
      let abortedReads = 0;
      const addEventListener = vi.fn(source.addEventListener.bind(source));
      const removeEventListener = vi.fn(source.removeEventListener.bind(source));
      const signal = new Proxy(source, {
        get(target, property) {
          if (property === "aborted") abortedReads++;
          if (property === "addEventListener") return addEventListener;
          if (property === "removeEventListener") return removeEventListener;
          // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
          const value = property in target ? target[property as keyof AbortSignal] : undefined;
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
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
      const addEventListener = vi.fn(controller.signal.addEventListener.bind(controller.signal));
      const removeEventListener = vi.fn(
        controller.signal.removeEventListener.bind(controller.signal),
      );
      const signal = new Proxy(controller.signal, {
        get(target, property) {
          if (property === "addEventListener") return addEventListener;
          if (property === "removeEventListener") return removeEventListener;
          // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
          const value = property in target ? target[property as keyof AbortSignal] : undefined;
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });
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
      const source = new AbortController().signal;
      const addEventListener = vi.fn(source.addEventListener.bind(source));
      const removeEventListener = vi.fn(source.removeEventListener.bind(source));
      h.ctx.signal = new Proxy(source, {
        get(target, property) {
          if (property === "addEventListener") return addEventListener;
          if (property === "removeEventListener") return removeEventListener;
          // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
          const value = property in target ? target[property as keyof AbortSignal] : undefined;
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });

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

  it.effect("shuts down the prior session before a hostile session signal can mutate state", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const hostile = { ...h.ctx } as ExtensionContext;
      Object.defineProperty(hostile, "signal", {
        get() {
          throw new Error("signal host failure");
        },
      });

      yield* emit(h, "session_start", {}, hostile);
      expect(h.setFooter).toHaveBeenCalledTimes(2);
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("shuts down the prior session when the next session cwd cannot be captured", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const hostile = { ...h.ctx } as ExtensionContext;
      Object.defineProperty(hostile, "cwd", {
        get() {
          throw new Error("cwd host failure");
        },
      });

      yield* emit(h, "session_start", {}, hostile);
      expect(h.setFooter).toHaveBeenCalledTimes(2);
      expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("contains delayed branch subscription lifecycle callbacks", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      const factory = h.setFooter.mock.calls[0]?.[0];
      let branchChanged: (() => void) | undefined;
      const unsubscribe = vi.fn(() => {
        throw new Error("unsubscribe host failure");
      });
      const footer = factory(
        {
          requestRender() {
            throw new Error("render host failure");
          },
        },
        { fg: (_color: string, text: string) => text },
        {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          getAvailableProviderCount: () => 1,
          onBranchChange(callback: () => void) {
            branchChanged = callback;
            return unsubscribe;
          },
        },
      );

      expect(() => branchChanged?.()).not.toThrow();
      expect(() => footer.dispose()).not.toThrow();
      expect(unsubscribe).toHaveBeenCalledOnce();
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("contains delayed branch subscription creation failures", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      const factory = h.setFooter.mock.calls[0]?.[0];
      expect(() =>
        factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange() {
              throw new Error("subscription host failure");
            },
          },
        ),
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
      const footerData = (unsubscribe: () => void) => ({
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => unsubscribe,
      });
      h.setFooter
        .mockImplementationOnce((factory) => {
          staleFooter = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text },
            footerData(staleUnsubscribe),
          );
          throw new Error("setFooter failed after factory creation");
        })
        .mockImplementationOnce((factory) => {
          activeFooter = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text },
            footerData(vi.fn()),
          );
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
      const factory = h.setFooter.mock.calls[0]?.[0];
      const makeFooter = (unsubscribe: () => void) =>
        factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: () => unsubscribe,
          },
        );
      const first = makeFooter(firstUnsubscribe);
      makeFooter(secondUnsubscribe);

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
          installedFooter = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text },
            {
              getGitBranch: () => null,
              getExtensionStatuses: () => new Map(),
              getAvailableProviderCount: () => 1,
              onBranchChange: () => unsubscribe,
            },
          );
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

  it.effect("session abort interrupts startup probes without waiting for them", () =>
    Effect.gen(function* () {
      const h = harness();
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      const pending = installPendingExec(h);
      const startup = yield* emit(h, "session_start").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* waitUntil(() => pending.started() === 2);
      controller.abort();
      yield* Fiber.join(startup);
      yield* waitUntil(() => pending.aborted() === 2);
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
        const factory = h.setFooter.mock.calls[0]?.[0];
        const footer = factory(
          { requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => "main",
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 1,
            onBranchChange: () => vi.fn(),
          },
        );
        h.exec.mockResolvedValueOnce({
          stdout: "## main...origin/main\n",
          stderr: "",
          code: 0,
          killed: false,
        });

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

      yield* Deferred.succeed(finishTickerShutdown, undefined);
      yield* Fiber.join(shutdown);
      expect(settled).toBe(true);
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
