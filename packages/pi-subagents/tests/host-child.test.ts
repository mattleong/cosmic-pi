// Promise-shaped child Pi host boundary tests.
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { queryQuestionnaireRelay } from "pi-ask-user/protocol";
import {
  createEventBus,
  type ExtensionHandler,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { deferredPromise, extensionContextFixture } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, vi } from "vitest";
import type { LocalPiContact, LocalPiParentControl } from "../src/backend/local-pi-protocol.ts";
import {
  registerSubagentChildBridge,
  type SubagentChildBridgeBoundaries,
} from "../src/boundary/host-child.ts";
import { ParentContactError, type LocalPiChildIpcHandlers } from "../src/boundary/local-pi-ipc.ts";
import { SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";
import { statusContract } from "../src/tools/contract.ts";
import { view } from "./fixtures/run-view.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";
import { describeActivationLifecycle } from "./support/activation-lifecycle.ts";
import { effectTest, eventLoopTurn, settle, step } from "./support/effect-test.ts";
import { pickQuestionnaire } from "./support/questionnaire.ts";

type Handler = ExtensionHandler<any, any>;
type CapturedTool = ToolDefinition<any, any, any>;
type CapturedToolInput = Parameters<CapturedTool["execute"]>[1];

interface ListenerRecord {
  readonly handlers: LocalPiChildIpcHandlers;
  detached: boolean;
}

interface HarnessOptions {
  readonly loadSettings?: SubagentChildBridgeBoundaries["loadSettings"] | undefined;
  readonly failSend?: (contact: LocalPiContact) => ParentContactError | undefined;
  readonly throwAtRegistration?: number;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const handlers = new Map<string, Handler>();
  const events = createEventBus();
  const tools: CapturedTool[] = [];
  const contacts: LocalPiContact[] = [];
  const listeners: ListenerRecord[] = [];
  let active = ["read"];
  let registration = 0;
  const sendMessage = vi.fn();
  const ipc = {
    sendContact: (contact: LocalPiContact) =>
      Effect.suspend(() => {
        contacts.push(contact);
        const failure = options.failSend?.(contact);
        return failure ? Effect.fail(failure) : Effect.void;
      }),
    listen: (listenerHandlers: LocalPiChildIpcHandlers) => {
      const record: ListenerRecord = { handlers: listenerHandlers, detached: false };
      listeners.push(record);
      return () => {
        record.detached = true;
      };
    },
  };
  const pi = extensionApiFixture({
    events,
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn((tool: CapturedTool) => {
      registration += 1;
      tools.push(tool);
      active = [...new Set([...active, tool.name])];
      if (registration === options.throwAtRegistration) throw new Error("registration failed");
    }),
    on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
      active = [...names];
    }),
    sendMessage,
  });
  registerSubagentChildBridge(pi, {
    loadSettings: options.loadSettings ?? (() => Promise.resolve()),
    openIpc: () => ipc,
  });
  const context = (cwd = "/child") =>
    extensionContextFixture({
      cwd,
      sessionManager: { getSessionId: () => cwd },
      signal: undefined,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc" as const,
    });
  const start = (cwd?: string) =>
    Promise.resolve(handlers.get("session_start")?.({}, context(cwd)));
  const shutdown = () =>
    Promise.resolve(handlers.get("session_shutdown")?.({}, context())).then(() => undefined);
  const latestTool = (name: string): CapturedTool => {
    const tool = tools.findLast((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
  };
  const currentListener = (): ListenerRecord => {
    const listener = listeners.findLast((candidate) => !candidate.detached);
    if (!listener) throw new Error("Missing active IPC listener");
    return listener;
  };
  /** Waits until the latest contact of one type exists and matches the expected fields. */
  const awaitContact = <Type extends LocalPiContact["type"]>(
    type: Type,
    match: Partial<Extract<LocalPiContact, { readonly type: Type }>> = {},
  ) =>
    step(() =>
      vi.waitFor(() => {
        const contact = contactOfType(contacts, type);
        expect(contact).toMatchObject(match);
        return contact!;
      }),
    );
  /** Asks the parent a blocking question through the current contact_parent tool. */
  const ask = (signal?: AbortSignal) =>
    execute(latestTool("contact_parent"), { kind: "question", message: "Need input" }, signal);
  return {
    events,
    activeTools: () => [...active],
    ask,
    awaitContact,
    contacts,
    currentListener,
    latestTool,
    listeners,
    sendMessage,
    start,
    shutdown,
    tools,
  };
};

const execute = (tool: CapturedTool, params: CapturedToolInput, signal: AbortSignal | undefined) =>
  Promise.resolve(tool.execute("call", params, signal, undefined, extensionContextFixture({})));

function contactOfType<Type extends LocalPiContact["type"]>(
  contacts: ReadonlyArray<LocalPiContact>,
  type: Type,
): Extract<LocalPiContact, { readonly type: Type }> | undefined {
  return contacts.findLast(
    (contact): contact is Extract<LocalPiContact, { readonly type: Type }> => contact.type === type,
  );
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: Error) => error,
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local Pi child bridge", () => {
  effectTest("renders registered child tools without sending parent requests", function* () {
    const restore = applyPresentationSettings({
      toolCallCollapsedStyle: "compact",
      toolCallTiming: false,
    });
    const bridge = makeHarness();
    try {
      yield* step(() => bridge.start());
      for (const name of [...SUBAGENT_TOOL_NAMES, "contact_parent"]) {
        const cycled = createToolPresentationHarness(bridge.latestTool(name)).cycle(
          { kind: "question", message: "input evidence" },
          { content: [{ type: "text", text: "reply evidence sentinel" }], details: {} },
        );
        for (const { expanded, text } of cycled)
          if (expanded) expect(text).toContain("reply evidence sentinel");
      }
      expect(bridge.contacts).toEqual([]);
    } finally {
      yield* step(bridge.shutdown);
      restore();
    }
  });
  effectTest("cancels an owned questionnaire on reload and revokes the old relay", function* () {
    const harness = makeHarness();
    yield* step(() => harness.start("/old"));
    const relay = queryQuestionnaireRelay(harness.events, "/old")!;
    const answer = rejection(relay.ask(pickQuestionnaire, new AbortController().signal));
    const request = yield* harness.awaitContact("proxy_request");
    yield* step(() => harness.start("/new"));
    expect(contactOfType(harness.contacts, "proxy_cancel")?.requestId).toBe(request.requestId);
    expect(queryQuestionnaireRelay(harness.events, "/old")).toBeUndefined();
    expect(yield* step(() => answer)).toBeInstanceOf(Error);
    yield* step(harness.shutdown);
  });
  effectTest("sends no teardown cancel for a questionnaire the root already failed", function* () {
    const harness = makeHarness();
    yield* step(() => harness.start());
    const relay = queryQuestionnaireRelay(harness.events, "/child")!;
    const answer = rejection(relay.ask(pickQuestionnaire, new AbortController().signal));
    const request = yield* harness.awaitContact("proxy_request");
    harness.currentListener().handlers.onControl({
      channel: "pi-subagents",
      type: "proxy_response",
      requestId: request.requestId,
      ok: false,
      payloadJson: '{"message":"The parent questionnaire is unavailable."}',
    });
    expect(yield* step(() => answer)).toBeInstanceOf(Error);
    yield* settle(harness.shutdown);
    expect(contactOfType(harness.contacts, "proxy_cancel")).toBeUndefined();
  });
  effectTest("aborts superseded preview loading and ignores its late settlement", function* () {
    const first = deferredPromise();
    const second = deferredPromise();
    const signals: AbortSignal[] = [];
    let loads = 0;
    const harness = makeHarness({
      loadSettings: (_cwd, _trusted, signal) => {
        signals.push(signal);
        loads += 1;
        return loads === 1 ? first.promise : second.promise;
      },
    });

    const firstStart = harness.start("/first");
    yield* step(() => vi.waitFor(() => expect(signals).toHaveLength(1)));
    const secondStart = harness.start("/second");
    yield* step(() =>
      vi.waitFor(() => {
        expect(signals[0]?.aborted).toBe(true);
        expect(signals).toHaveLength(2);
      }),
    );
    second.resolve();
    yield* step(() => secondStart);
    const winningContact = harness.latestTool("contact_parent");
    expect(harness.listeners[0]?.detached).toBe(true);
    expect(harness.activeTools()).toEqual(
      expect.arrayContaining(["contact_parent", "subagent_start"]),
    );

    first.resolve();
    yield* step(() => firstStart);
    yield* step(() => first.promise);
    expect(harness.latestTool("contact_parent")).toBe(winningContact);
    yield* settle(harness.shutdown);
  });

  effectTest("rejects a structured proxy result for a different coordinator tool", function* () {
    const harness = makeHarness();
    yield* settle(harness.start);
    const pending = rejection(
      execute(
        harness.latestTool(SUBAGENT_TOOL_NAME.await),
        { runIds: ["a"], until: "all_finished" },
        undefined,
      ),
    );
    const request = yield* harness.awaitContact("proxy_request");
    harness.currentListener().handlers.onControl({
      channel: "pi-subagents",
      type: "proxy_response",
      requestId: request.requestId,
      ok: true,
      payloadJson: JSON.stringify({
        content: [{ type: "text", text: "Unrelated status" }],
        structuredContent: statusContract({
          observations: [{ run: view({ id: "a" }) }],
          fullyRenderedIds: new Set(),
          missingRunIds: [],
        }),
      }),
    });
    expect(yield* step(() => pending)).toBeDefined();
    yield* settle(harness.shutdown);
  });

  effectTest("re-registers on reload and rejects stale tool definitions", function* () {
    const harness = makeHarness();
    yield* settle(() => harness.start("/first"));
    const staleContact = harness.latestTool("contact_parent");
    const staleProxy = harness.latestTool(SUBAGENT_TOOL_NAME.list);
    const staleListener = harness.currentListener().handlers;
    const staleInFlight = rejection(execute(staleProxy, {}, undefined));
    const staleRequest = yield* harness.awaitContact("proxy_request");

    yield* settle(() => harness.start("/second"));
    expect(yield* step(() => staleInFlight)).toMatchObject({
      message: "The root subagent coordinator disconnected.",
    });
    staleListener.onControl({
      channel: "pi-subagents",
      type: "proxy_response",
      requestId: staleRequest.requestId,
      ok: true,
      payloadJson: '{"content":[{"type":"text","text":"late"}]}',
    });
    yield* step(eventLoopTurn);
    const currentContact = harness.latestTool("contact_parent");
    expect(currentContact).not.toBe(staleContact);
    const sentBefore = harness.contacts.length;
    yield* step(() =>
      expect(
        execute(staleContact, { kind: "progress", message: "old" }, undefined),
      ).rejects.toThrow("Parent contact is unavailable for this session."),
    );
    yield* step(() =>
      expect(execute(staleProxy, {}, undefined)).rejects.toThrow(
        "Subagent proxy is unavailable for this session.",
      ),
    );
    expect(harness.contacts).toHaveLength(sentBefore);

    yield* step(() =>
      expect(
        execute(currentContact, { kind: "progress", message: "current" }, undefined),
      ).resolves.toMatchObject({ content: [{ text: "Parent received progress." }] }),
    );
    yield* settle(harness.shutdown);
  });

  effectTest(
    "returns a persisted cancelled proxy await with requested IDs and unobserved states",
    function* () {
      const harness = makeHarness();
      yield* settle(harness.start);
      const controller = new AbortController();
      const waiting = execute(
        harness.latestTool("subagent_await"),
        { runIds: ["agent-child"], until: "all_finished" },
        controller.signal,
      );
      const request = yield* harness.awaitContact("proxy_request");
      controller.abort();
      const result = yield* step(() => waiting);
      expect(result.details).toMatchObject({
        action: "await",
        cancelled: true,
        awaitedRunIds: ["agent-child"],
        cancellationCleanup: "unconfirmed",
        cards: [],
      });
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      // The agent learns that root cleanup is unconfirmed, not complete.
      expect(text).toContain("Root completion-claim cleanup is unconfirmed");
      expect(text).not.toContain("Wait cleanup is complete");
      yield* harness.awaitContact("proxy_cancel", { requestId: request.requestId });
      const immediate = yield* step(() =>
        execute(
          harness.latestTool("subagent_await"),
          { runIds: ["agent-other"], until: "any_finished" },
          controller.signal,
        ),
      );
      expect(immediate.details).toMatchObject({ cancelled: true, awaitedRunIds: ["agent-other"] });
      yield* settle(harness.shutdown);
    },
  );

  effectTest("cancels exact proxy calls and parent questions", function* () {
    const harness = makeHarness();
    yield* settle(harness.start);

    const proxyAbort = new AbortController();
    const proxyOutcome = rejection(
      execute(harness.latestTool(SUBAGENT_TOOL_NAME.list), {}, proxyAbort.signal),
    );
    const proxyRequest = yield* harness.awaitContact("proxy_request");
    proxyAbort.abort();
    expect(yield* step(() => proxyOutcome)).toBeDefined();
    yield* harness.awaitContact("proxy_cancel", { requestId: proxyRequest.requestId });

    const questionAbort = new AbortController();
    const questionOutcome = rejection(harness.ask(questionAbort.signal));
    const question = yield* harness.awaitContact("contact_parent");
    questionAbort.abort();
    expect(yield* step(() => questionOutcome)).toMatchObject({
      message: "Parent question was cancelled.",
    });
    yield* harness.awaitContact("contact_cancel", { requestId: question.requestId });
    yield* settle(harness.shutdown);
  });

  effectTest("does not cancel a question that was definitely not sent", function* () {
    const harness = makeHarness({
      failSend: (contact) =>
        contact.type === "contact_parent"
          ? new ParentContactError({
              code: "transport_not_sent",
              message: "The parent subagent supervisor is unavailable.",
            })
          : undefined,
    });
    yield* settle(harness.start);

    yield* step(() =>
      expect(harness.ask()).rejects.toThrow("The parent subagent supervisor is unavailable."),
    );
    expect(contactOfType(harness.contacts, "contact_cancel")).toBeUndefined();
    yield* settle(harness.shutdown);
  });

  effectTest("rejects correlated waits on disconnect and shutdown", function* () {
    for (const end of ["disconnect", "shutdown"] as const) {
      const harness = makeHarness();
      yield* settle(harness.start);
      const questionOutcome = rejection(harness.ask());
      const proxyOutcome = rejection(
        execute(harness.latestTool(SUBAGENT_TOOL_NAME.list), {}, undefined),
      );
      yield* harness.awaitContact("contact_parent");
      yield* harness.awaitContact("proxy_request");

      if (end === "disconnect") harness.currentListener().handlers.onDisconnect();
      else yield* settle(harness.shutdown);
      expect(yield* step(() => questionOutcome)).toMatchObject({
        message: "The parent subagent supervisor disconnected.",
      });
      expect(yield* step(() => proxyOutcome)).toMatchObject({
        message: "The root subagent coordinator disconnected.",
      });
      if (end === "disconnect") yield* settle(harness.shutdown);
    }
  });

  effectTest("handles acknowledgements only from the current listener", function* () {
    const harness = makeHarness();
    yield* settle(() => harness.start("/first"));
    const stale = harness.currentListener().handlers;
    yield* settle(() => harness.start("/second"));
    const current = harness.currentListener().handlers;
    harness.contacts.length = 0;

    stale.onControl({
      channel: "pi-subagents",
      type: "turn_input_barrier",
      requestId: "stale-barrier",
    });
    stale.onControl({
      channel: "pi-subagents",
      type: "proxy_notification",
      requestId: "stale-notification",
      message: "old",
    });
    yield* step(eventLoopTurn);
    expect(harness.contacts).toHaveLength(0);
    expect(harness.sendMessage).not.toHaveBeenCalled();

    current.onControl({
      channel: "pi-subagents",
      type: "turn_input_barrier",
      requestId: "current-barrier",
    });
    yield* harness.awaitContact("turn_input_barrier_ack", { requestId: "current-barrier" });

    const result = harness.ask();
    const question = yield* harness.awaitContact("contact_parent");
    const reply: LocalPiParentControl = {
      channel: "pi-subagents",
      type: "parent_reply",
      requestId: question.requestId,
      ackId: "reply-ack",
      message: "approved",
    };
    stale.onDisconnect();
    yield* step(eventLoopTurn);
    stale.onControl(reply);
    yield* step(eventLoopTurn);
    expect(contactOfType(harness.contacts, "parent_reply_ack")).toBeUndefined();
    current.onControl(reply);
    yield* step(() =>
      expect(result).resolves.toMatchObject({
        content: [{ text: "Parent reply: approved" }],
      }),
    );
    yield* harness.awaitContact("parent_reply_ack", { requestId: "reply-ack", ok: true });
    yield* settle(harness.shutdown);
  });

  effectTest("removes proxy names and shuts down after partial registration", function* () {
    const harness = makeHarness({ throwAtRegistration: 2 });
    yield* settle(harness.start);
    yield* step(() => vi.waitFor(() => expect(harness.listeners[0]?.detached).toBe(true)));
    expect(harness.activeTools()).toEqual(["read"]);
    const partial = harness.tools.find((tool) => tool.name === SUBAGENT_TOOL_NAME.models);
    expect(partial).toBeDefined();
    yield* step(() =>
      expect(execute(partial!, {}, undefined)).rejects.toThrow(
        "Subagent proxy is unavailable for this session.",
      ),
    );
    yield* settle(harness.shutdown);
  });
});

describeActivationLifecycle("child bridge", (loadSettings) => {
  const harness = makeHarness({ loadSettings });
  return {
    start: () => harness.start(),
    shutdown: harness.shutdown,
    registeredToolCount: () => harness.tools.length,
    activeTools: harness.activeTools,
  };
});
