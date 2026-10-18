import { queryQuestionnaireRelay } from "pi-ask-user/protocol";
import { createEventBus, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
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
import { childProcessEnvironment, childToolPolicy } from "../src/boundary/child-process.ts";
import type { LocalPiChildIpcHandlers, ParentContactError } from "../src/boundary/local-pi-ipc.ts";
import {
  NESTED_START_GUIDELINE,
  NESTED_WORKSPACE_PARENT_START_GUIDELINE,
} from "../src/delegation/prompt.ts";
import { backendLaunchRequest } from "../src/run/launch-records.ts";
import type { StartSubagentRequest } from "../src/run/model.ts";
import { AGENT_TOOL_NAMES, SUBAGENT_TOOL_NAME } from "../src/run/tool-policy.ts";
import { lifecycleContract } from "../src/tools/contract.ts";
import { view } from "./fixtures/run-view.ts";
import { request as startRequest } from "./run/fixtures/service-harness.ts";
import { describeActivationLifecycle } from "./support/activation-lifecycle.ts";
import { effectTest, eventLoopTurn, settle, step } from "./support/effect-test.ts";
import { pickQuestionnaire } from "./support/questionnaire.ts";

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

const childContext = (cwd = "/child") =>
  extensionContextFixture({
    cwd,
    sessionManager: { getSessionId: () => cwd },
    signal: undefined,
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
  const start = (cwd?: string) => host.emit("session_start", childContext(cwd));
  const shutdown = () => host.emit("session_shutdown", childContext());
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
    (cause: unknown) => cause,
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local Pi child bridge", () => {
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

const workspace = {
  workspaceId: "ws-child",
  ownerId: "session-1/root",
  sourceCwd: "/repo",
  sourceRoot: "/repo",
  cwd: "/private/ws-child",
};

/** Launches an admitted run and returns the marker its Pi child process would see. */
const childWorkspaceMarker = (overrides: Partial<StartSubagentRequest>) => {
  const launch = backendLaunchRequest(
    {
      request: startRequest(overrides),
      parentRunId: "root",
      cwd: "/project",
    },
    { id: "child-1", name: "child" },
  );
  // The coordinator's own marker never leaks into a child that is not a workspace parent.
  const environment = childProcessEnvironment({ PI_SUBAGENT_WORKSPACE_PARENT: "1" }, launch);
  return { launch, marker: environment.PI_SUBAGENT_WORKSPACE_PARENT };
};

const nestedSurfaces: ReadonlyArray<
  readonly [string, Partial<StartSubagentRequest>, workspaceParent: boolean]
> = [
  [
    "worktree writer",
    { writeIntent: "writer", writerWorkspaceMode: "worktree", workspace, cwd: workspace.cwd },
    true,
  ],
  ["reader", {}, false],
  [
    "shared-checkout writer",
    { writeIntent: "writer", writerWorkspaceMode: "shared-checkout" },
    false,
  ],
];

describe("nested workspace surface", () => {
  for (const [kind, overrides, workspaceParent] of nestedSurfaces)
    effectTest(
      `${workspaceParent ? "exposes" : "withholds"} agent_worktree for a ${kind} child`,
      function* () {
        const { launch, marker } = childWorkspaceMarker(overrides);
        // Always stub, so a marker inherited from an enclosing subagent can't leak in.
        vi.stubEnv("PI_SUBAGENT_WORKSPACE_PARENT", marker);
        const harness = makeHarness();
        yield* settle(harness.start);
        const names = harness.tools.map((tool) => tool.name);
        // Proxies of the root's agent_* tools, plus the child's own parent contact.
        expect(new Set(names)).toEqual(
          new Set([
            "agent_profiles",
            "agent_start",
            "agent_await",
            "agent_lifecycle",
            ...(workspaceParent ? ["agent_worktree"] : []),
            "agent_list",
            "agent_send",
            "agent_read",
            "agent_contact_parent",
          ]),
        );
        expect(names.includes(SUBAGENT_TOOL_NAME.workspace)).toBe(workspaceParent);
        expect(harness.activeTools().includes(SUBAGENT_TOOL_NAME.workspace)).toBe(workspaceParent);
        // Every child coordinates with the session's agents, whatever its tool policy.
        expect(harness.activeTools()).toEqual(expect.arrayContaining([...AGENT_TOOL_NAMES]));
        expect(
          childToolPolicy(["read"], launch.workspaceParent === true).enabled.includes(
            SUBAGENT_TOOL_NAME.workspace,
          ),
        ).toBe(workspaceParent);
        expect(harness.latestTool(SUBAGENT_TOOL_NAME.start).promptGuidelines).toContain(
          workspaceParent ? NESTED_WORKSPACE_PARENT_START_GUIDELINE : NESTED_START_GUIDELINE,
        );
        yield* settle(harness.shutdown);
        expect(harness.activeTools()).toEqual(["read"]);
      },
    );

  effectTest("proxies a worktree writer's workspace calls to the root coordinator", function* () {
    vi.stubEnv("PI_SUBAGENT_WORKSPACE_PARENT", "1");
    const harness = makeHarness();
    yield* settle(harness.start);
    const pending = execute(
      harness.latestTool(SUBAGENT_TOOL_NAME.workspace),
      { action: "list" },
      undefined,
    );
    const proxied = yield* harness.awaitContact("proxy_request", {
      tool: SUBAGENT_TOOL_NAME.workspace,
    });
    harness.currentListener().handlers.onControl({
      channel: "pi-subagents",
      type: "proxy_response",
      requestId: proxied.requestId,
      ok: true,
      payloadJson: '{"content":[{"type":"text","text":"No workspaces."}]}',
    });
    expect(yield* step(() => pending)).toMatchObject({
      content: [{ type: "text", text: "No workspaces." }],
    });
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
