import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { AGENT_MESSAGE_TYPE, agentMainCapabilities } from "../src/boundary/host-agent-messages.ts";
import { registerParentWake } from "../src/boundary/host-parent-wake.ts";
import { MAIN_AGENT_ID, type AgentCaller } from "../src/run/agent-messaging.ts";
import { projectionOf } from "./fixtures/run-view.ts";
import { localServiceFixture, request, withService } from "./run/fixtures/service-harness.ts";
import * as Arr from "effect/Array";

const assistantEntry = (id: string, text: string): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: fauxAssistantMessage(text),
});

const settleEvent = (
  contextMessages: AgentBeforeSettleEvent["context"]["contextMessages"],
): AgentBeforeSettleEvent => ({
  type: "agent_before_settle",
  outcome: "completed",
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [...contextMessages],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  },
});

/** A root session whose main agent receives agent messages through the shared parent wake. */
const rootSession = () => {
  let idle = true;
  let branch: ReadonlyArray<SessionEntry> = [];
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const host = recordingExtensionHost({}, { sendMessage });
  const wake = registerParentWake(host.pi, {
    projection: () => projectionOf([]),
    drain: () => undefined,
    isIdle: () => idle,
    later: () => undefined,
  });
  const ctx: ExtensionContext = extensionContextFixture({
    isIdle: () => idle,
    sessionManager: { getBranch: () => [...branch] },
  });
  let current = true;
  const main = agentMainCapabilities(host.pi, { wake, session: () => (current ? ctx : undefined) });
  const messages = () =>
    Arr.filter(sendMessage.mock.calls, ([message]) => message.customType === AGENT_MESSAGE_TYPE);
  return {
    host,
    ctx,
    main,
    messages,
    setIdle: (next: boolean) => {
      idle = next;
    },
    setBranch: (next: ReadonlyArray<SessionEntry>) => {
      branch = next;
    },
    retire: () => {
      current = false;
    },
    settle: (event: AgentBeforeSettleEvent) => {
      const [handler] = host.handlers.get("agent_before_settle");
      return Promise.resolve(handler?.(event, ctx));
    },
  };
};

const asRun = (id: string): AgentCaller => ({ kind: "run", runId: id });

describe("agent messages to the main agent", () => {
  it.effect("wakes an idle main agent, queues for a busy one, and holds after an interrupt", () => {
    const root = rootSession();
    const { layer } = localServiceFixture({ agentMain: root.main });
    return withService(layer, function* (service) {
      const scout = yield* service.start(request({ name: "api-scout" }));

      const woken = yield* service.agentSend(asRun(scout.id), MAIN_AGENT_ID, "Schema found.");
      expect(woken).toMatchObject({ disposition: "guided", mainState: "idle" });
      const [message, options] = root.messages()[0] ?? [];
      expect(options).toMatchObject({ triggerTurn: true });
      expect(message).toMatchObject({
        display: true,
        details: { from: scout.id, fromName: "api-scout", to: MAIN_AGENT_ID },
      });
      expect(message?.content).toContain("Schema found.");

      root.setIdle(false);
      const queued = yield* service.agentSend(asRun(scout.id), MAIN_AGENT_ID, "Also the CLI.");
      expect(queued.mainState).toBe("busy");
      expect(root.messages()[1]?.[1]).toMatchObject({ triggerTurn: false });
      // The busy run continues at its settle boundary so the model sees the message.
      const settled = yield* Effect.promise(() =>
        root.settle(
          settleEvent([
            fauxAssistantMessage("Working."),
            {
              role: "custom",
              customType: AGENT_MESSAGE_TYPE,
              content: "Also the CLI.",
              display: true,
              timestamp: 0,
            },
          ]),
        ),
      );
      expect(settled).toMatchObject({ continue: true });

      yield* Effect.promise(() =>
        root.host.emit("agent_settled", root.ctx, { type: "agent_settled", aborted: true }),
      );
      root.setIdle(true);
      yield* TestClock.adjust("5 seconds");
      const held = yield* service.agentSend(asRun(scout.id), MAIN_AGENT_ID, "Done.");
      expect(held.mainState).toBe("held");
      expect(root.messages()[2]?.[1]).toMatchObject({ triggerTurn: false });

      root.retire();
      yield* TestClock.adjust("5 seconds");
      const refused = yield* service
        .agentSend(asRun(scout.id), MAIN_AGENT_ID, "Anyone?")
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "agent_unavailable" });
    });
  });

  it.effect("refuses a message to a main agent whose session is being replaced", () => {
    const root = rootSession();
    const { layer } = localServiceFixture({ agentMain: root.main });
    return withService(layer, function* (service) {
      const scout = yield* service.start(request({ name: "api-scout" }));
      yield* Effect.promise(() =>
        root.host.emit("session_before_switch", root.ctx, {
          type: "session_before_switch",
          reason: "new",
        }),
      );

      const refused = yield* service
        .agentSend(asRun(scout.id), MAIN_AGENT_ID, "Schema found.")
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "agent_unavailable" });
      expect(root.messages()).toHaveLength(0);

      // Pi reports no cancelled switch; the session is still open when its user prompts again.
      yield* Effect.promise(() =>
        root.host.emit("input", root.ctx, { type: "input", text: "Go on.", source: "interactive" }),
      );
      yield* TestClock.adjust("5 seconds");
      const woken = yield* service.agentSend(asRun(scout.id), MAIN_AGENT_ID, "Schema found.");
      expect(woken.mainState).toBe("idle");
    });
  });

  it.effect("reads the main agent's latest assistant text on the current branch", () => {
    const root = rootSession();
    const { layer } = localServiceFixture({ agentMain: root.main });
    return withService(layer, function* (service) {
      const scout = yield* service.start(request({ name: "api-scout" }));
      root.setBranch([
        assistantEntry("a-1", "Earlier plan."),
        assistantEntry("a-2", "Current plan: map the API."),
      ]);
      root.setIdle(false);
      const read = yield* service.agentRead(asRun(scout.id), [MAIN_AGENT_ID]);
      expect(read.agents).toEqual([
        expect.objectContaining({
          kind: "main",
          state: "busy",
          text: "Current plan: map the API.",
          truncated: false,
        }),
      ]);
      const listed = yield* service.agentList(asRun(scout.id), [MAIN_AGENT_ID]);
      expect(listed.agents).toEqual([expect.objectContaining({ id: "main", state: "busy" })]);
    });
  });

  it.effect("continues a busy main agent for agent messages at every settle", () => {
    const root = rootSession();
    const { layer } = localServiceFixture({ agentMain: root.main });
    return withService(layer, function* (service) {
      const scout = yield* service.start(request({ name: "api-scout" }));
      const reviewer = yield* service.start(request({ name: "reviewer" }));
      root.setIdle(false);
      const messageInContext = {
        role: "custom" as const,
        customType: AGENT_MESSAGE_TYPE,
        content: "Another finding.",
        display: true,
        timestamp: 0,
      };
      const rounds: Array<{
        readonly mainStates: ReadonlyArray<string | undefined>;
        continued: boolean;
      }> = [];
      for (let round = 0; round < 5; round += 1) {
        // Two senders' messages during one turn share its single continuation.
        const first = yield* service.agentSend(asRun(scout.id), MAIN_AGENT_ID, "Finding.");
        const second = yield* service.agentSend(asRun(reviewer.id), MAIN_AGENT_ID, "Review.");
        const settled = yield* Effect.promise(() =>
          root.settle(settleEvent([fauxAssistantMessage("Working."), messageInContext])),
        );
        rounds.push({
          mainStates: [first.mainState, second.mainState],
          continued: settled?.continue === true,
        });
      }
      expect(rounds).toEqual([
        { mainStates: ["busy", "busy"], continued: true },
        { mainStates: ["busy", "busy"], continued: true },
        { mainStates: ["busy", "busy"], continued: true },
        { mainStates: ["busy", "busy"], continued: true },
        { mainStates: ["busy", "busy"], continued: true },
      ]);
      expect(Arr.every(root.messages(), ([, options]) => options?.triggerTurn === false)).toBe(
        true,
      );
    });
  });

  it.effect("reads an unavailable main agent once its session was replaced", () => {
    const root = rootSession();
    const { layer } = localServiceFixture({ agentMain: root.main });
    return withService(layer, function* (service) {
      const scout = yield* service.start(request({ name: "api-scout" }));
      root.retire();
      const read = yield* service.agentRead(asRun(scout.id), [MAIN_AGENT_ID]);
      expect(read).toEqual({
        agents: [
          expect.objectContaining({ kind: "main", state: "unavailable", textStatus: "none" }),
        ],
        missingIds: [],
      });
    });
  });
});
