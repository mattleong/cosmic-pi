// @effect-diagnostics effect/abortController:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import * as Predicate from "effect/Predicate";
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";

import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import cosmicUi from "../index.ts";
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

function harness(mode: "tui" | "rpc" = "tui") {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Set<BusHandler>>();
  const setFooter = vi.fn();
  const setWorkingMessage = vi.fn();
  const unsubscribed = vi.fn();
  const exec = vi.fn(
    async (command: string, args: string[], _options?: { signal?: AbortSignal }) => ({
      stdout:
        command === "gh"
          ? "42\n"
          : args[0] === "diff"
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
  cosmicUi(pi);
  return { pi, ctx, handlers, setFooter, setWorkingMessage, exec, unsubscribed };
}

async function emit(h: ReturnType<typeof harness>, name: string): Promise<void>;
async function emit<EventInput>(
  h: ReturnType<typeof harness>,
  name: string,
  event: EventInput,
): Promise<void>;
async function emit<EventInput>(
  h: ReturnType<typeof harness>,
  name: string,
  event?: EventInput,
): Promise<void> {
  for (const handler of h.handlers.get(name) ?? []) await handler(event ?? {}, h.ctx);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error("condition did not become true");
    },
    { timeout: 1_000, interval: 1 },
  );
}

function installPendingExec(h: ReturnType<typeof harness>) {
  let started = 0;
  let aborted = 0;
  h.exec.mockImplementation(
    (_command: string, _args: string[], options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        started++;
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  return { started: () => started, aborted: () => aborted };
}

const successfulExec = async (command: string) => ({
  stdout: command === "gh" ? "7\n" : "## current\n",
  stderr: "",
  code: 0,
  killed: false,
});

describe("Cosmic UI extension", () => {
  test("answers host queries and installs an ANSI-safe responsive footer in TUI mode", async () => {
    const h = harness();
    let found = false;
    h.pi.events.emit(COSMIC_UI_HOST_QUERY, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      respond: () => {
        found = true;
      },
    });
    expect(found).toBe(true);
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "malformed",
      contribution: { kind: "surface", id: "broken", region: "media", preferredWidth: 4 },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-better-openai",
      contribution: {
        kind: "text",
        id: "openai.usage",
        region: "details",
        text: "Usage: 5h: 90% | 7d: 51%",
        label: "OpenAI",
      },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-better-xai",
      contribution: {
        kind: "text",
        id: "xai.usage",
        region: "details",
        text: "Usage: 7d: 82% | mo: 83%",
        label: "xAI",
      },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-better-openai",
      contribution: {
        kind: "text",
        id: "openai.fast",
        region: "identity",
        text: "⚡",
        color: "syntaxFunction",
        decorates: "effort",
      },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-advisor",
      contribution: {
        kind: "status",
        id: "pi-advisor",
        region: "identity",
        align: "right",
        priority: 100,
        order: 1000,
      },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-subagents",
      contribution: { kind: "status", id: "pi-subagents", region: "details", order: 1000 },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-background-terminals",
      contribution: {
        kind: "status",
        id: "pi-background-terminals",
        region: "details",
        order: 1010,
      },
    });
    await emit(h, "session_start");
    expect(h.ctx.isProjectTrusted).toHaveBeenCalledOnce();
    expect(h.setFooter).toHaveBeenCalledOnce();
    const factory = h.setFooter.mock.calls[0]?.[0];
    const footer = factory(
      { requestRender: vi.fn() },
      { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[0m` },
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () =>
          new Map([
            ["pi-advisor", "⠋ review-model:medium advising…"],
            ["pi-background-terminals", "2 background jobs active · 1 failed"],
            ["pi-subagents", "3 subagents active · 1 awaiting reply"],
            ["other-extension", "other ready"],
          ]),
        getAvailableProviderCount: () => 2,
        onBranchChange: () => vi.fn(),
      },
    );
    for (const width of [32, 64, 100])
      expect(footer.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
    const renderedLines = footer.render(100);
    const rendered = renderedLines.join("\n");
    expect(renderedLines[0]).toContain("Model");
    expect(renderedLines[0]).toContain("provider");
    expect(renderedLines[0]).toContain("model-long-name");
    expect(renderedLines[0]).toContain("⚡high");
    expect(renderedLines[0]).not.toContain(" fast");
    expect(renderedLines[0]).toContain("⠋ review-model:medium advising…");
    expect(renderedLines.slice(1).join("\n")).not.toContain("review-model:medium advising");
    expect(renderedLines[1]).toContain("Repo");
    expect(renderedLines[1]).toContain("/tmp/project");
    expect(rendered).toContain("Ctx");
    expect(rendered).toContain("OpenAI");
    expect(rendered).toContain("xAI");
    expect(rendered).toContain("mo");
    expect(rendered).toContain("main");
    expect(rendered).toContain("PR #42");
    expect(renderedLines[1]).toContain("main");
    expect(renderedLines[1]).toContain("PR #42");
    const plainRepositoryLine = stripVTControlCharacters(renderedLines[1] ?? "");
    expect(plainRepositoryLine).toMatch(/PR #42\s{2,}~1 \?1 • \+6L ~4L$/);
    expect(rendered).toContain("~1 ?1");
    expect(rendered).toContain("+6L");
    expect(rendered).toContain("~4L");
    expect(rendered).toContain("other ready");
    const compactStatusLines = footer.render(64);
    const subagentLine = compactStatusLines.findIndex((line: string) =>
      line.includes("3 subagents active"),
    );
    const backgroundLine = compactStatusLines.findIndex((line: string) =>
      line.includes("2 background jobs active"),
    );
    expect(subagentLine).toBeGreaterThanOrEqual(0);
    expect(backgroundLine).toBeGreaterThan(subagentLine);
    expect(rendered.indexOf("model-long-name")).toBeLessThan(rendered.indexOf("high"));
    expect(rendered.indexOf("high")).toBeLessThan(rendered.indexOf("/tmp/project"));
    expect(h.ctx.getContextUsage).toHaveBeenCalledTimes(1);
    await emit(h, "message_update");
    footer.render(100);
    expect(h.ctx.getContextUsage).toHaveBeenCalledTimes(2);
  });

  test("shows elapsed working time for an agent run and restores Pi's default afterward", async () => {
    const h = harness();
    await emit(h, "session_start");

    await emit(h, "agent_start");
    await waitUntil(() => h.setWorkingMessage.mock.calls.length > 0);
    expect(h.setWorkingMessage).toHaveBeenLastCalledWith("Working · 0s");

    await emit(h, "agent_end");
    await waitUntil(() =>
      h.setWorkingMessage.mock.calls.some(([message]) => message === undefined),
    );
    expect(h.setWorkingMessage).toHaveBeenLastCalledWith(undefined);
    await emit(h, "session_shutdown");
  });

  test("normalizes hostile protocol getters once and isolates throwing reads", async () => {
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
    await emit(h, "session_start");
    expect(() =>
      h.pi.events.emit(COSMIC_UI_FOOTER_INVALIDATE, {
        version: 1,
        get owner() {
          return invalidateOwner();
        },
        id: "surface",
      }),
    ).not.toThrow();
    await waitUntil(() => invalidate.mock.calls.length === 1);
    expect(() =>
      h.pi.events.emit(COSMIC_UI_FOOTER_REMOVE, {
        version: 1,
        owner: "owner",
        get id() {
          return removeId();
        },
      }),
    ).not.toThrow();
    await waitUntil(() => dispose.mock.calls.length === 1);

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
    await emit(h, "session_shutdown");
  });

  test("reinstalls the footer when session_start supplies a new context", async () => {
    const h = harness();
    await emit(h, "session_start");
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
    for (const handler of h.handlers.get("session_start") ?? []) await handler({}, secondContext);

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
    for (const handler of h.handlers.get("model_select") ?? []) await handler({}, laterContext);
    const laterRendered = footer.render(100);
    expect(laterRendered[0]).toBe("Model   later-model • high");
    expect(laterRendered[1]).toContain("Repo    /tmp/later-project");
    expect(laterRendered.join("\n")).toContain("later-session");
  });

  test("immediately disposes in-flight startup probes on overlapping session replacement", async () => {
    const h = harness();
    const pending = installPendingExec(h);
    const first = emit(h, "session_start");
    await waitUntil(() => pending.started() === 2);

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
    await Promise.all([first, second]);
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
  });

  test("shutdown during startup survives throwing surfaces and releases every probe", async () => {
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
    const startup = emit(h, "session_start");
    await waitUntil(() => pending.started() === 2);
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
    await Promise.all([startup, emit(h, "session_shutdown")]);
    expect(pending.aborted()).toBe(2);
    expect(callbacks.attach).toHaveBeenCalledOnce();
    expect(callbacks.detach).toHaveBeenCalledOnce();
    expect(callbacks.dispose).toHaveBeenCalledOnce();
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("reports startup I/O failure and permits a clean subsequent session", async () => {
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
    await emit(h, "session_start");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("Cosmic UI failed to start.", "warning");
    expect(h.setFooter).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledOnce();

    h.ctx.cwd = process.cwd();
    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledTimes(2);
    await emit(h, "session_shutdown");
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  test("retries footer installation after the host rejects the first setFooter call", async () => {
    const h = harness();
    h.setFooter.mockImplementationOnce(() => {
      throw new Error("host rejected footer");
    });

    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenCalledOnce();

    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenCalledTimes(2);
    expect(h.setFooter.mock.calls[1]?.[0]).toEqual(expect.any(Function));

    await emit(h, "session_shutdown");
  });

  test("retains complete same-session totals but resets them before a failing new session", async () => {
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
    await emit(h, "session_start");
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

    await emit(h, "session_compact");
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
    for (const handler of h.handlers.get("session_start") ?? []) await handler({}, secondContext);
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
    await emit(h, "session_shutdown");
  });

  test("retains complete totals when a turn usage getter throws", async () => {
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
    await emit(h, "session_start");
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

    await emit(h, "turn_end", { message: { role: "assistant", usage } });
    expect(input).toHaveBeenCalledOnce();
    expect(footer.render(100).join("\n")).toContain("↑50");
    await emit(h, "session_shutdown");
  });

  test("fails closed when the live context mode getter throws", async () => {
    const h = harness();
    Object.defineProperty(h.ctx, "mode", {
      get() {
        throw new Error("mode host failure");
      },
    });
    await emit(h, "session_start");
    expect(h.setFooter).not.toHaveBeenCalled();
    await emit(h, "session_shutdown");
  });

  test("materializes session cwd, signal, and initial abort state exactly once", async () => {
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

    await emit(h, "session_start");
    expect(cwdReads).toBe(1);
    expect(signalReads).toBe(1);
    expect(abortedReads).toBe(1);
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(h.setFooter).toHaveBeenCalledOnce();
    await emit(h, "session_shutdown");
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  test("observes an abort between session capture and runtime listener registration", async () => {
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

    await emit(h, "session_start");

    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(h.setFooter).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });

  test("releases short-lived event abort forwarders when runtime work settles", async () => {
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

    await emit(h, "session_start");
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).not.toHaveBeenCalled();

    await emit(h, "turn_end");
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(removeEventListener).toHaveBeenCalledOnce();

    await emit(h, "session_shutdown");
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  test("shuts down the prior session before a hostile session signal can mutate state", async () => {
    const h = harness();
    await emit(h, "session_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const hostile = { ...h.ctx } as ExtensionContext;
    Object.defineProperty(hostile, "signal", {
      get() {
        throw new Error("signal host failure");
      },
    });

    for (const handler of h.handlers.get("session_start") ?? []) await handler({}, hostile);
    expect(h.setFooter).toHaveBeenCalledTimes(2);
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    await emit(h, "session_shutdown");
  });

  test("shuts down the prior session when the next session cwd cannot be captured", async () => {
    const h = harness();
    await emit(h, "session_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const hostile = { ...h.ctx } as ExtensionContext;
    Object.defineProperty(hostile, "cwd", {
      get() {
        throw new Error("cwd host failure");
      },
    });

    for (const handler of h.handlers.get("session_start") ?? []) await handler({}, hostile);
    expect(h.setFooter).toHaveBeenCalledTimes(2);
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    await emit(h, "session_shutdown");
  });

  test("contains delayed branch subscription lifecycle callbacks", async () => {
    const h = harness();
    await emit(h, "session_start");
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
    await emit(h, "session_shutdown");
  });

  test("contains delayed branch subscription creation failures", async () => {
    const h = harness();
    await emit(h, "session_start");
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
    await emit(h, "session_shutdown");
  });

  test("stale failed-factory disposal cannot clear a successful retry", async () => {
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

    await emit(h, "session_start");
    expect(staleUnsubscribe).toHaveBeenCalledOnce();
    await emit(h, "session_start");
    expect(activeFooter).toBeDefined();

    staleFooter?.dispose();
    expect(staleUnsubscribe).toHaveBeenCalledOnce();
    await emit(h, "session_shutdown");
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("an older instance cannot dispose a newer footer from the same factory", async () => {
    const h = harness();
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    await emit(h, "session_start");
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
    await emit(h, "session_shutdown");
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(secondUnsubscribe).toHaveBeenCalledOnce();
  });

  test("retries footer removal after the host rejects a pre-disposal clear", async () => {
    const h = harness();
    let removalAttempts = 0;
    h.setFooter.mockImplementation((factory) => {
      if (factory !== undefined) return;
      removalAttempts++;
      if (removalAttempts === 1) throw new Error("footer still installed");
    });

    await emit(h, "session_start");
    await emit(h, "session_shutdown");

    expect(removalAttempts).toBe(2);
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("relinquishes footer ownership when the host disposes before rejecting removal", async () => {
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

    await emit(h, "session_start");
    await emit(h, "session_shutdown");
    expect(removalAttempts).toBe(1);
    expect(unsubscribe).toHaveBeenCalledOnce();

    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    await emit(h, "session_shutdown");
  });

  test("session abort interrupts startup probes without waiting for them", async () => {
    const h = harness();
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    const pending = installPendingExec(h);
    const startup = emit(h, "session_start");
    await waitUntil(() => pending.started() === 2);
    controller.abort();
    await startup;
    await waitUntil(() => pending.aborted() === 2);
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("polls git status so external commits and edits refresh automatically", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await emit(h, "session_start");
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

      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.exec).toHaveBeenCalledTimes(4);
      const cleanFooter = footer.render(100).join("\n");
      expect(cleanFooter).not.toContain("clean");
      expect(cleanFooter).not.toContain("~1 ?1");

      await emit(h, "session_shutdown");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.exec).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("session abort removes the footer and interrupts the active runtime", async () => {
    const h = harness();
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    await emit(h, "session_start");
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("releases protocol subscriptions exactly once on repeated shutdown", async () => {
    const h = harness();
    await emit(h, "session_start");
    await emit(h, "session_shutdown");
    await emit(h, "session_shutdown");
    expect(h.unsubscribed).toHaveBeenCalledTimes(4);
  });

  test("does not install terminal footer UI in RPC mode", async () => {
    const h = harness("rpc");
    await emit(h, "session_start");
    expect(h.setFooter).not.toHaveBeenCalled();
  });
});
