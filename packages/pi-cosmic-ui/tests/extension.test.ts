import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";
import {
  deferredPromise,
  extensionContextFixture,
  modelFixture,
  plainTheme,
  recordingExtensionHost,
  tuiFixture,
  type DefaultedEventName,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import cosmicUi from "../index.ts";
import type { CosmicUiApplicationDependencies } from "../src/application.ts";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_PROTOCOL_VERSION,
} from "../src/protocol/protocol.ts";
import { ACTIVITY_DISCOVER, ACTIVITY_EVENT } from "../src/activity/protocol.ts";
import { ACTIVITY_VIEW_DISCOVER } from "../src/activity/view-protocol.ts";
import {
  abortablePendingExec,
  capturedSignal,
  eventBus,
  execOk,
  execResult,
} from "./support/host.ts";

function harness(dependencies?: CosmicUiApplicationDependencies) {
  const setFooter = vi.fn<ExtensionUIContext["setFooter"]>();
  const setWorkingMessage = vi.fn();
  const unsubscribed = vi.fn<(name: string) => void>();
  const exec = vi.fn((command: string, args: string[], _options?: { signal?: AbortSignal }) =>
    execOk(
      command === "gh"
        ? '{"number":42,"url":"https://github.com/team/project/pull/42"}'
        : args.includes("diff")
          ? "10\t4\tchanged.ts\n"
          : "## main...origin/main\n M changed.ts\n?? new.ts\n",
    ),
  );
  const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const { pi, handlers, emit } = recordingExtensionHost(
    {},
    {
      registerCommand,
      getThinkingLevel: vi.fn<ExtensionAPI["getThinkingLevel"]>(() => "high"),
      exec,
      events: eventBus(unsubscribed).events,
    },
  );
  const ctx = extensionContextFixture({
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: modelFixture(harnessModel),
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    getContextUsage: vi.fn(() => ({ contextWindow: 100_000, tokens: 12_500, percent: 12.5 })),
    sessionManager: {
      getEntries: vi.fn(() => assistantEntries()),
      getCwd: vi.fn(() => "/tmp/project"),
      getSessionName: vi.fn(() => "session"),
      getLeafId: vi.fn(() => "leaf"),
    },
    ui: { setFooter, setWorkingMessage, notify, custom: vi.fn() },
    isProjectTrusted: vi.fn(() => true),
  });
  cosmicUi(pi, dependencies);
  return {
    pi,
    ctx,
    handlers,
    emit,
    setFooter,
    setWorkingMessage,
    exec,
    unsubscribed,
    registerCommand,
    notify,
  };
}

const harnessModel = {
  id: "model-long-name",
  provider: "provider",
  reasoning: true,
  contextWindow: 100_000,
};

const emit = (
  h: ReturnType<typeof harness>,
  name: DefaultedEventName,
  context: ExtensionContext = h.ctx,
): Effect.Effect<void> => Effect.promise(() => h.emit(name, context));

const emitEvent = (
  h: ReturnType<typeof harness>,
  event: ExtensionEvent,
  context: ExtensionContext = h.ctx,
): Effect.Effect<void> => Effect.promise(() => h.emit(event.type, context, event));

const waitUntil = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.promise(() =>
    vi.waitFor(
      () => {
        if (!predicate()) throw new Error("condition did not become true");
      },
      { timeout: 1_000, interval: 1 },
    ),
  );

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
type FooterData = Parameters<FooterFactory>[2];

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
  factory: FooterFactory | undefined,
  data: Partial<FooterData> = {},
  requestRender: () => void = vi.fn(),
) {
  if (!factory) throw new Error("Expected an installed footer factory.");
  const component = factory(tuiFixture({ requestRender }), plainTheme, footerData(data));
  if (!component.dispose) throw new Error("Expected a disposable footer.");
  return {
    render: (width: number) => component.render(width),
    dispose: () => component.dispose?.(),
  };
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

function assistantEntries(...inputs: number[]): SessionEntries {
  return inputs.map((input) => ({
    id: entryBase.id,
    parentId: entryBase.parentId,
    timestamp: entryBase.timestamp,
    type: "message",
    message: {
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: nativeUsage(input),
      stopReason: "stop",
      timestamp: 0,
    },
  }));
}
type AssistantMessage = Extract<
  ExtensionEventNamed<"message_end">["message"],
  { readonly role: "assistant" }
>;
const assistantMessage = (usage = nativeUsage(0)): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "test",
  provider: "test",
  model: "test",
  usage,
  stopReason: "stop",
  timestamp: 0,
});
const turnEnd = (message = assistantMessage()): ExtensionEventNamed<"turn_end"> => ({
  type: "turn_end",
  turnIndex: 0,
  message,
  toolResults: [],
  messageEntryId: "entry",
  toolResultEntryIds: [],
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: false,
  },
  outcome: "completed",
});
const uiPrompt = (
  type: "ui_prompt_start" | "ui_prompt_end",
): ExtensionEventNamed<"ui_prompt_start" | "ui_prompt_end"> => ({
  type,
  reason: "ui_prompt",
  kind: "custom",
});
const usageEntry = (kind: string, input: number) => ({
  ...entryBase,
  type: "usage" as const,
  kind,
  provider: "test",
  model: "test",
  usage: nativeUsage(input),
});

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

const byName = (left: string, right: string) => left.localeCompare(right);

describe("Cosmic UI extension", () => {
  it.effect(
    "immediately disposes in-flight startup probes on overlapping session replacement",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const { startup: first, aborted } = yield* startWithPendingProbes(h);
        h.exec.mockImplementation((command) =>
          execOk(
            command === "gh"
              ? '{"number":7,"url":"https://github.com/team/project/pull/7"}'
              : "## current\n",
          ),
        );
        const secondContext = withSession(h.ctx, {
          getCwd: () => "/tmp/replacement",
          getSessionName: () => "replacement",
        });
        const second = Promise.all(
          (h.handlers.get("session_start") ?? []).map((handler) =>
            Promise.resolve(handler({ type: "session_start", reason: "startup" }, secondContext)),
          ),
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

  it.effect(
    "reports startup I/O failure and permits a clean subsequent session with prior contributions",
    () =>
      Effect.gen(function* () {
        const h = harness();
        h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
          version: COSMIC_UI_PROTOCOL_VERSION,
          owner: "early",
          contribution: { kind: "text", id: "early", region: "details", text: "early-text" },
        });
        const { signal, addEventListener, removeEventListener } = capturedSignal();
        h.ctx.signal = signal;
        h.ctx.cwd = "\0invalid";
        yield* emit(h, "session_start");
        expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
        expect(h.setFooter).not.toHaveBeenCalled();
        expect(removeEventListener).toHaveBeenCalledOnce();

        h.ctx.cwd = process.cwd();
        yield* emit(h, "session_start");
        expect(h.setFooter).toHaveBeenCalledOnce();
        expectFooterShows(capturedFooter(h), "early-text");
        expect(addEventListener).toHaveBeenCalledTimes(2);
        yield* emit(h, "session_shutdown");
        expect(removeEventListener).toHaveBeenCalledTimes(2);
      }),
  );

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
      yield* emitEvent(h, { type: "message_end", message: assistantMessage(hostileUsage) });
      yield* emitEvent(h, turnEnd(assistantMessage(usage)));
      yield* emit(h, "agent_settled");
      expect(input).not.toHaveBeenCalled();
      expect(footer.render(100).join("\n")).toContain("↑90");
      entries.push(usageEntry("cache_warm", 10));
      yield* emit(h, "agent_settled");
      expect(footer.render(100).join("\n")).toContain("↑100");
      yield* emit(h, "session_shutdown");
    }),
  );

  it.effect("late events from a replaced session cannot overwrite the replacement's usage", () =>
    Effect.gen(function* () {
      const h = harness();
      const retired = h.ctx;
      retired.sessionManager.getEntries = vi.fn(() => [usageEntry("cache_warm", 11)]);
      yield* emit(h, "session_start");
      expectFooterShows(capturedFooter(h), "↑11");
      const replacement = withSession(retired, {
        getEntries: vi.fn(() => [usageEntry("cache_warm", 22)]),
      });
      yield* emit(h, "session_start", replacement);
      const footer = capturedFooter(h, -1);
      expectFooterShows(footer, "↑22");

      yield* emitEvent(
        h,
        { type: "tool_execution_start", toolCallId: "late", toolName: "read", args: {} },
        retired,
      );
      yield* emit(h, "agent_settled", retired);
      expectFooterShows(footer, "↑22");
      // The replacement's own reconciliation still reads its session.
      yield* emit(h, "agent_settled", replacement);
      expectFooterShows(footer, "↑22");
      yield* emit(h, "session_shutdown", replacement);
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

  for (const property of ["cwd"] as const) {
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

        yield* emit(h, "session_start", hostile);
        expect(h.setFooter).toHaveBeenCalledTimes(2);
        expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
        yield* emit(h, "session_shutdown");
      }),
    );
  }

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

  it.effect("a prompt end admitted by a replaced session cannot resume the new timer", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* emit(h, "session_start");
      yield* emit(h, "agent_start");
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");
      yield* emitEvent(h, uiPrompt("ui_prompt_start"));
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Waiting for you");

      const replacement = withSession(h.ctx, {
        getCwd: () => "/tmp/replacement",
        getSessionName: () => "replacement",
      });
      yield* emit(h, "session_start", replacement);
      yield* emit(h, "agent_start", replacement);
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");

      const writesBeforeStaleEnd = h.setWorkingMessage.mock.calls.length;
      yield* emitEvent(h, uiPrompt("ui_prompt_end"), replacement);
      yield* Effect.yieldNow;
      expect(h.setWorkingMessage).toHaveBeenCalledTimes(writesBeforeStaleEnd);

      yield* emitEvent(h, uiPrompt("ui_prompt_start"), replacement);
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Waiting for you");
      yield* emitEvent(h, uiPrompt("ui_prompt_end"), replacement);
      yield* waitUntil(() => h.setWorkingMessage.mock.calls.at(-1)?.[0] === "Working · 0s");
      yield* emit(h, "session_shutdown");
    }),
  );

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
        expect(cleanFooter).not.toContain("~1 ?1");

        yield* emit(h, "session_shutdown");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        expect(h.exec).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    }),
  );

  it.effect("awaits shared ticker cleanup during session shutdown", () => {
    const tickerShutdown = deferredPromise();
    const shutdownHostUiTickers = vi.fn(() => tickerShutdown.promise);
    const h = harness({ shutdownHostUiTickers });
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
      tickerShutdown.resolve();
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
      const released = h.unsubscribed.mock.calls.map(([name]) => name).toSorted(byName);
      expect(released).toEqual(
        [
          COSMIC_UI_HOST_QUERY,
          COSMIC_UI_FOOTER_UPSERT,
          COSMIC_UI_FOOTER_REMOVE,
          ACTIVITY_EVENT,
          ACTIVITY_DISCOVER,
          ACTIVITY_VIEW_DISCOVER,
        ].toSorted(byName),
      );
      yield* emit(h, "session_shutdown");
      expect(h.unsubscribed).toHaveBeenCalledTimes(released.length);
    }),
  );
});
