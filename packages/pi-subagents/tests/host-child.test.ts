import { queryQuestionnaireRelay } from "pi-ask-user/protocol";
import { createEventBus, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { afterEach, describe, expect, vi } from "vitest";
import type { LocalPiContact, LocalPiParentControl } from "../src/backend/local-pi-protocol.ts";
import {
  registerSubagentChildBridge,
  type SubagentChildBridgeBoundaries,
} from "../src/boundary/host-child.ts";
import { childToolPolicy } from "../src/boundary/child-process.ts";
import type { LocalPiChildIpcHandlers, ParentContactError } from "../src/boundary/local-pi-ipc.ts";
import { NESTED_START_GUIDELINE } from "../src/delegation/prompt.ts";
import { AGENT_TOOL_NAMES, SUBAGENT_TOOL_NAME } from "../src/run/tool-policy.ts";
import { cancelledAwaitContract, lifecycleContract } from "../src/tools/contract.ts";
import { beforeAgentStartEvent } from "./fixtures/pi-host.ts";
import { view } from "./fixtures/run-view.ts";
import { describeActivationLifecycle } from "./support/activation-lifecycle.ts";
import { effectTest, eventLoopTurn, settle, step } from "./support/effect-test.ts";
import { pickQuestionnaire } from "./support/questionnaire.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

type CapturedTool = ToolDefinition;
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

const childContext = (cwd = "/child", isIdle = () => true) =>
  extensionContextFixture({
    cwd,
    sessionManager: { getSessionId: () => cwd },
    signal: undefined,
    isIdle,
    isProjectTrusted: () => true,
    hasUI: false,
    mode: "rpc" as const,
  });

const makeHarness = (options: HarnessOptions = {}) => {
  const events = createEventBus();
  const tools: CapturedTool[] = [];
  const contacts: LocalPiContact[] = [];
  const listeners: ListenerRecord[] = [];
  let active = ["read"];
  let registration = 0;
  let idle = true;
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
  const host = recordingExtensionHost(
    {},
    {
      events,
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: (tool) => {
        registration += 1;
        tools.push(defineTool(tool));
        active = [...new Set([...active, tool.name])];
        if (registration === options.throwAtRegistration) throw new Error("registration failed");
      },
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      }),
      sendMessage,
    },
  );
  registerSubagentChildBridge(host.pi, {
    loadSettings: options.loadSettings ?? (() => Promise.resolve()),
    openIpc: () => ipc,
  });
  const start = (cwd?: string) =>
    host.emit(
      "session_start",
      childContext(cwd, () => idle),
    );
  // The parent's prompt opens a run, the only time the child takes descendant notices.
  const openRun = () => {
    idle = false;
    return host.emit("before_agent_start", childContext(), beforeAgentStartEvent("Task"));
  };
  const shutdown = () => host.emit("session_shutdown", childContext());
  const latestTool = (name: string): CapturedTool => {
    const tool = Option.getOrUndefined(Arr.findLast(tools, (candidate) => candidate.name === name));
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
  };
  const currentListener = (): ListenerRecord => {
    const listener = Option.getOrUndefined(
      Arr.findLast(listeners, (candidate) => !candidate.detached),
    );
    if (!listener) throw new Error("Missing active IPC listener");
    return listener;
  };
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
  const ask = (signal?: AbortSignal) =>
    execute(
      latestTool("agent_contact_parent"),
      { kind: "question", message: "Need input" },
      signal,
    );
  return {
    events,
    activeTools: () => [...active],
    ask,
    awaitContact,
    contacts,
    currentListener,
    latestTool,
    listeners,
    openRun,
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
  return Option.getOrUndefined(
    Arr.findLast(
      contacts,
      (contact): contact is Extract<LocalPiContact, { readonly type: Type }> =>
        contact.type === type,
    ),
  );
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

// Management proxies wrap their arguments with the caller's parent context.
const decodeForwardedTimeout = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      argumentsJson: Schema.fromJsonString(Schema.Struct({ timeoutSeconds: Schema.Finite })),
    }),
  ),
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local Pi child bridge", () => {
  effectTest("cancels an owned questionnaire on reload and revokes the old relay", function* () {
    const harness = makeHarness();
    yield* step(() => harness.start("/old"));
    const relay = queryQuestionnaireRelay(harness.events, "/old")!;
    const answer = rejection(
      Promise.resolve<unknown>(relay.ask(pickQuestionnaire, new AbortController().signal)),
    );
    const request = yield* harness.awaitContact("proxy_request");
    yield* step(() => harness.start("/new"));
    expect(contactOfType(harness.contacts, "proxy_cancel")?.requestId).toBe(request.requestId);
    expect(queryQuestionnaireRelay(harness.events, "/old")).toBeUndefined();
    expect(yield* step(() => answer)).toBeInstanceOf(Error);
    yield* step(harness.shutdown);
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
    const winningContact = harness.latestTool("agent_contact_parent");
    expect(harness.listeners[0]?.detached).toBe(true);
    expect(harness.activeTools()).toEqual(
      expect.arrayContaining(["agent_contact_parent", "agent_start"]),
    );

    first.resolve();
    yield* step(() => firstStart);
    yield* step(() => first.promise);
    expect(harness.latestTool("agent_contact_parent")).toBe(winningContact);
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
        content: [{ type: "text", text: "Unrelated stop" }],
        structuredContent: lifecycleContract("stop", [{ runId: "a", run: view({ id: "a" }) }]),
      }),
    });
    expect(yield* step(() => pending)).toBeDefined();
    yield* settle(harness.shutdown);
  });

  effectTest(
    "leaves a nested await's clamped timeout to the root, behind a backstop",
    function* () {
      const harness = makeHarness();
      yield* settle(harness.start);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        let settled = false;
        const pending = execute(
          harness.latestTool(SUBAGENT_TOOL_NAME.await),
          { runIds: ["a"], until: "all_finished", timeoutSeconds: 86_400 },
          undefined,
        ).finally(() => {
          settled = true;
        });
        const request = yield* harness.awaitContact("proxy_request");
        expect(decodeForwardedTimeout(request.argumentsJson).argumentsJson.timeoutSeconds).toBe(
          3_600,
        );
        // The root answers at the timeout, so within its backstop the child neither gives up nor
        // cancels on its own.
        yield* step(() => vi.advanceTimersByTimeAsync(3_600_000 + 29_000));
        expect(settled).toBe(false);
        expect(contactOfType(harness.contacts, "proxy_cancel")).toBeUndefined();
        harness.currentListener().handlers.onControl({
          channel: "pi-subagents",
          type: "proxy_response",
          requestId: request.requestId,
          ok: true,
          payloadJson: JSON.stringify({
            content: [{ type: "text", text: "Await timed out after 3600s" }],
            structuredContent: cancelledAwaitContract({
              runs: [view({ id: "a" })],
              requestedRunIds: ["a"],
              until: "all_finished",
              cleanup: "confirmed",
              ending: "timed_out",
              now: 0,
            }),
          }),
        });
        expect((yield* step(() => pending)).structuredContent).toMatchObject({
          outcome: "timed_out",
          cleanup: "confirmed",
        });
      } finally {
        vi.useRealTimers();
      }

      // A root answer lost while the connection stays up ends at the backstop, as a timeout that
      // cancels the wait at the root and doesn't claim its cleanup.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        const lost = execute(
          harness.latestTool(SUBAGENT_TOOL_NAME.await),
          { runIds: ["a"], until: "all_finished", timeoutSeconds: 60 },
          undefined,
        );
        yield* step(() =>
          vi.waitFor(() =>
            expect(
              Arr.filter(harness.contacts, (contact) => contact.type === "proxy_request"),
            ).toHaveLength(2),
          ),
        );
        const lostRequest = yield* harness.awaitContact("proxy_request");
        yield* step(() => vi.advanceTimersByTimeAsync(90_000));
        expect((yield* step(() => lost)).structuredContent).toMatchObject({
          outcome: "timed_out",
          cleanup: "unconfirmed",
        });
        yield* harness.awaitContact("proxy_cancel", { requestId: lostRequest.requestId });
      } finally {
        vi.useRealTimers();
      }

      // The caller's own abort still ends a timed wait at once and cancels it at the root.
      const abort = new AbortController();
      const cancelled = execute(
        harness.latestTool(SUBAGENT_TOOL_NAME.await),
        { runIds: ["a"], until: "all_finished", timeoutSeconds: 60 },
        abort.signal,
      );
      yield* step(() =>
        vi.waitFor(() =>
          expect(
            Arr.filter(harness.contacts, (contact) => contact.type === "proxy_request"),
          ).toHaveLength(3),
        ),
      );
      const cancelledRequest = yield* harness.awaitContact("proxy_request");
      abort.abort();
      expect((yield* step(() => cancelled)).structuredContent).toMatchObject({
        outcome: "cancelled",
        cleanup: "unconfirmed",
      });
      yield* harness.awaitContact("proxy_cancel", { requestId: cancelledRequest.requestId });
      yield* settle(harness.shutdown);
    },
  );

  // The root may have delivered reports in an answer the cancellation cut off.
  effectTest("points a cancelled nested wait or start at agent_read", function* () {
    const harness = makeHarness();
    yield* settle(harness.start);
    const waitAbort = new AbortController();
    const wait = execute(
      harness.latestTool(SUBAGENT_TOOL_NAME.await),
      { runIds: ["a"], until: "all_finished" },
      waitAbort.signal,
    );
    yield* harness.awaitContact("proxy_request");
    waitAbort.abort();
    const cancelled = yield* step(() => wait);
    expect(cancelled.structuredContent).toMatchObject({
      outcome: "cancelled",
      cleanup: "unconfirmed",
    });
    expect(JSON.stringify(cancelled.content)).toContain("agent_read");

    const startAbort = new AbortController();
    const start = rejection(
      execute(
        harness.latestTool(SUBAGENT_TOOL_NAME.start),
        { agents: [{ task: "Inspect" }] },
        startAbort.signal,
      ),
    );
    yield* step(() =>
      vi.waitFor(() =>
        expect(
          Arr.filter(harness.contacts, (contact) => contact.type === "proxy_request"),
        ).toHaveLength(2),
      ),
    );
    startAbort.abort();
    const failure = yield* step(() => start);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain("agent_read");
    yield* settle(harness.shutdown);
  });

  effectTest("re-registers on reload and rejects stale tool definitions", function* () {
    const harness = makeHarness();
    yield* settle(() => harness.start("/first"));
    const staleContact = harness.latestTool("agent_contact_parent");
    const staleProxy = harness.latestTool(SUBAGENT_TOOL_NAME.models);
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
    const currentContact = harness.latestTool("agent_contact_parent");
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

  effectTest("cancels exact proxy calls and parent questions", function* () {
    const harness = makeHarness();
    yield* settle(harness.start);

    const proxyAbort = new AbortController();
    const proxyOutcome = rejection(
      execute(harness.latestTool(SUBAGENT_TOOL_NAME.models), {}, proxyAbort.signal),
    );
    const proxyRequest = yield* harness.awaitContact("proxy_request");
    proxyAbort.abort();
    expect(yield* step(() => proxyOutcome)).toBeDefined();
    yield* harness.awaitContact("proxy_cancel", { requestId: proxyRequest.requestId });

    const questionAbort = new AbortController();
    const questionOutcome = rejection(harness.ask(questionAbort.signal));
    const question = yield* harness.awaitContact("contact_request");
    questionAbort.abort();
    expect(yield* step(() => questionOutcome)).toMatchObject({
      message: "Parent question was cancelled.",
    });
    yield* harness.awaitContact("contact_cancel", { requestId: question.requestId });
    yield* settle(harness.shutdown);
  });

  effectTest("keeps a parent question waiting for its reply without a deadline", function* () {
    const harness = makeHarness();
    yield* settle(harness.start);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      let settled = false;
      const result = harness.ask().finally(() => {
        settled = true;
      });
      const question = yield* harness.awaitContact("contact_request");
      yield* step(() => vi.advanceTimersByTimeAsync(24 * 60 * 60_000));
      expect(settled).toBe(false);
      expect(contactOfType(harness.contacts, "contact_cancel")).toBeUndefined();
      harness.currentListener().handlers.onControl({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: question.requestId,
        ackId: "late-reply",
        message: "still here",
      });
      yield* step(() =>
        expect(result).resolves.toMatchObject({ content: [{ text: "Parent reply: still here" }] }),
      );
    } finally {
      vi.useRealTimers();
    }
    yield* settle(harness.shutdown);
  });

  effectTest("rejects correlated waits on disconnect and shutdown", function* () {
    for (const end of ["disconnect", "shutdown"] as const) {
      const harness = makeHarness();
      yield* settle(harness.start);
      const questionOutcome = rejection(harness.ask());
      const proxyOutcome = rejection(
        execute(harness.latestTool(SUBAGENT_TOOL_NAME.models), {}, undefined),
      );
      yield* harness.awaitContact("contact_request");
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
      key: "agent-1:1",
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
    const question = yield* harness.awaitContact("contact_request");
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

  effectTest(
    "shows a retried descendant notice once after its acknowledgement was lost",
    function* () {
      const harness = makeHarness();
      yield* settle(() => harness.start("/repo"));
      const { handlers } = harness.currentListener();
      // No run is open, so the notice is refused and goes to another recipient.
      handlers.onControl({
        channel: "pi-subagents",
        type: "proxy_notification",
        requestId: "notice-early",
        key: "agent-1:1",
        message: "Descendant reported.",
      });
      yield* harness.awaitContact("proxy_notification_ack", {
        requestId: "notice-early",
        ok: false,
      });
      expect(harness.sendMessage).not.toHaveBeenCalled();
      yield* settle(harness.openRun);
      for (const requestId of ["notice-1", "notice-retry"]) {
        handlers.onControl({
          channel: "pi-subagents",
          type: "proxy_notification",
          requestId,
          key: "agent-1:1",
          message: "Descendant reported.",
        });
        yield* harness.awaitContact("proxy_notification_ack", { requestId, ok: true });
      }
      expect(harness.sendMessage).toHaveBeenCalledOnce();
      handlers.onControl({
        channel: "pi-subagents",
        type: "proxy_notification",
        requestId: "notice-2",
        key: "agent-1:2",
        message: "Descendant reported again.",
      });
      yield* harness.awaitContact("proxy_notification_ack", { requestId: "notice-2", ok: true });
      expect(harness.sendMessage).toHaveBeenCalledTimes(2);
      yield* settle(harness.shutdown);
    },
  );

  effectTest("removes proxy names and shuts down after partial registration", function* () {
    const harness = makeHarness({ throwAtRegistration: 2 });
    yield* settle(harness.start);
    yield* step(() => vi.waitFor(() => expect(harness.listeners[0]?.detached).toBe(true)));
    expect(harness.activeTools()).toEqual(["read"]);
    const partial = Option.getOrUndefined(
      Arr.findFirst(harness.tools, (tool) => tool.name === SUBAGENT_TOOL_NAME.models),
    );
    expect(partial).toBeDefined();
    yield* step(() =>
      expect(execute(partial!, {}, undefined)).rejects.toThrow(
        "Subagent proxy is unavailable for this session.",
      ),
    );
    yield* settle(harness.shutdown);
  });
});

describe("nested tool surface", () => {
  // Only the root starts worktree writers, so no child reviews or applies a worktree.
  effectTest("withholds agent_worktree from every child", function* () {
    const harness = makeHarness();
    yield* settle(harness.start);
    const names = Arr.map(harness.tools, (tool) => tool.name);
    // Proxies of the root's agent_* tools, plus the child's own parent contact.
    expect(new Set(names)).toEqual(
      new Set([
        "agent_profiles",
        "agent_start",
        "agent_await",
        "agent_lifecycle",
        "agent_list",
        "agent_send",
        "agent_read",
        "agent_contact_parent",
      ]),
    );
    expect(harness.activeTools()).not.toContain(SUBAGENT_TOOL_NAME.workspace);
    // Every child coordinates with the session's agents, whatever its tool policy.
    expect(harness.activeTools()).toEqual(expect.arrayContaining([...AGENT_TOOL_NAMES]));
    expect(childToolPolicy(["read"], "read-only").enabled).not.toContain(
      SUBAGENT_TOOL_NAME.workspace,
    );
    expect(harness.latestTool(SUBAGENT_TOOL_NAME.start).promptGuidelines).toContain(
      NESTED_START_GUIDELINE,
    );
    yield* settle(harness.shutdown);
    expect(harness.activeTools()).toEqual(["read"]);
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
