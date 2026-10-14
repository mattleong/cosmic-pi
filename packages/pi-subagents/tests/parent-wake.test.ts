import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import { registerParentWake } from "../src/boundary/host-parent-wake.ts";
import type { SubagentProjection } from "../src/run/model.ts";
import { beforeAgentStartEvent } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";
import { stringContaining } from "./support/matchers.ts";

const settleEvent = (
  outcome: AgentBeforeSettleEvent["outcome"] = "completed",
): AgentBeforeSettleEvent => ({
  type: "agent_before_settle",
  outcome,
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  },
});

const waiting = (id: string, requestId = "q-1") =>
  view({
    id,
    name: id,
    state: "waiting_for_parent",
    question: { requestId, message: `Which path for ${id}?` },
  });

const harness = (initial: SubagentProjection = projectionOf([])) => {
  let projection = initial;
  const drain = vi.fn(() => Promise.resolve());
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const host = recordingExtensionHost({}, { sendMessage });
  const wake = registerParentWake(host.pi, { projection: () => projection, drain });
  const notify = hostNotifier(host.pi, { triggerTurn: wake.mayStartTurn });
  const notices = vi.fn();
  const ctx = (mode: ExtensionContext["mode"] = "tui"): ExtensionContext =>
    extensionContextFixture({ mode, hasUI: mode === "tui", ui: { notify: notices } });
  const settle = (context: ExtensionContext, outcome?: AgentBeforeSettleEvent["outcome"]) => {
    const [handler] = host.handlers.get("agent_before_settle");
    return Promise.resolve(handler?.(settleEvent(outcome), context));
  };
  return {
    ...host,
    wake,
    notify,
    sendMessage,
    drain,
    notices,
    ctx,
    settle,
    setProjection: (next: SubagentProjection) => {
      projection = next;
    },
  };
};

const completed = { id: "agent-1", name: "reader", generation: 1, outcome: "completed" } as const;

describe("parent wake policy", () => {
  it.effect(
    "appends results without starting a turn after the user interrupts, until their next prompt",
    () =>
      Effect.gen(function* () {
        const test = harness(projectionOf([view({ state: "running" })]));
        const context = test.ctx();

        yield* Effect.promise(() =>
          test.emit("agent_settled", context, { type: "agent_settled", aborted: true }),
        );
        test.notify({ type: "completed", runs: [completed] });
        expect(test.sendMessage.mock.calls[0]?.[1]).toMatchObject({ triggerTurn: false });
        expect(test.notices).toHaveBeenCalledOnce();

        const custom = {
          ...beforeAgentStartEvent("unused"),
          messageType: "custom" as const,
          message: {
            role: "custom" as const,
            customType: "other",
            content: [],
            display: true,
            timestamp: 0,
          },
        };
        yield* Effect.promise(() => test.emit("before_agent_start", context, custom));
        expect(test.wake.mayStartTurn()).toBe(false);

        yield* Effect.promise(() =>
          test.emit("before_agent_start", context, beforeAgentStartEvent("next")),
        );
        test.notify({ type: "completed", runs: [{ ...completed, generation: 2 }] });
        expect(test.sendMessage.mock.calls[1]?.[1]).toMatchObject({ triggerTurn: true });
      }),
  );

  it.effect("keeps waking the parent after a run that finished normally", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: false }),
      );
      expect(test.wake.mayStartTurn()).toBe(true);
    }),
  );

  it.effect("reminds once about each pending question, then tells the user", () =>
    Effect.gen(function* () {
      const test = harness(projectionOf([waiting("agent-1")]));
      const context = test.ctx();

      const first = yield* Effect.promise(() => test.settle(context));
      expect(first).toMatchObject({ continue: true });
      expect(first?.entries?.[0]).toMatchObject({
        content: stringContaining("Which path for agent-1?"),
      });

      expect(yield* Effect.promise(() => test.settle(context))).toBeUndefined();
      expect(test.notices).toHaveBeenCalledOnce();
      expect(yield* Effect.promise(() => test.settle(context))).toBeUndefined();
      expect(test.notices).toHaveBeenCalledOnce();

      test.setProjection(projectionOf([waiting("agent-1", "q-2")]));
      expect(yield* Effect.promise(() => test.settle(context))).toMatchObject({ continue: true });
    }),
  );

  it.effect("does not remind about questions owned by a nested parent or after an interrupt", () =>
    Effect.gen(function* () {
      const nested = { ...waiting("agent-2"), parentRunId: "agent-1" };
      const test = harness(projectionOf([nested]));
      expect(yield* Effect.promise(() => test.settle(test.ctx()))).toBeUndefined();

      test.setProjection(projectionOf([waiting("agent-3")]));
      expect(yield* Effect.promise(() => test.settle(test.ctx(), "aborted"))).toBeUndefined();
    }),
  );

  it.effect("drains running children before a headless parent settles", () =>
    Effect.gen(function* () {
      const test = harness(projectionOf([view({ state: "running" })]));

      yield* Effect.promise(() => test.settle(test.ctx("tui")));
      expect(test.drain).not.toHaveBeenCalled();

      yield* Effect.promise(() => test.settle(test.ctx("print")));
      expect(test.drain).toHaveBeenCalledOnce();

      test.setProjection(projectionOf([view({ state: "completed" })]));
      yield* Effect.promise(() => test.settle(test.ctx("print")));
      expect(test.drain).toHaveBeenCalledOnce();
    }),
  );
});
