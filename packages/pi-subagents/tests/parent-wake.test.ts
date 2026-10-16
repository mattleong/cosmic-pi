import type {
  AgentBeforeSettleEvent,
  BoundaryContextPreview,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  extensionContextFixture,
  recordingExtensionHost,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import { registerParentWake, WAKE_MESSAGE_TYPE } from "../src/boundary/host-parent-wake.ts";
import type { SubagentProjection } from "../src/run/model.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";
import {
  contactParentFrame,
  localServiceFixture,
  request,
  withService,
} from "./run/fixtures/service-harness.ts";
import { stringContaining } from "./support/matchers.ts";

type ContextMessage = BoundaryContextPreview["contextMessages"][number];

const settleEvent = (
  outcome: AgentBeforeSettleEvent["outcome"] = "completed",
  contextMessages: ReadonlyArray<ContextMessage> = [],
  pendingMessages: ReadonlyArray<ContextMessage> = [],
): AgentBeforeSettleEvent => ({
  type: "agent_before_settle",
  outcome,
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [...contextMessages],
    llmMessages: [],
    pendingMessages: [...pendingMessages],
    canContinue: true,
  },
});

const notice = (customType = "pi-subagents-completed"): ContextMessage => ({
  role: "custom",
  customType,
  content: "Background subagent reader (agent-1) completed.",
  display: true,
  timestamp: 0,
});

const reply = (): ContextMessage => fauxAssistantMessage("Noted.");

const inputEvent = (source: InputEvent["source"]): InputEvent => ({
  type: "input",
  text: "next",
  source,
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
  let idle = true;
  const checks: Array<() => void> = [];
  const drain = vi.fn(() => Promise.resolve());
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const host = recordingExtensionHost({}, { sendMessage });
  const wake = registerParentWake(host.pi, {
    projection: () => projection,
    drain,
    isIdle: () => idle,
    later: (check) => checks.push(check),
  });
  const notify = hostNotifier(host.pi, { delivery: wake });
  const notices = vi.fn();
  const ctx = (mode: ExtensionContext["mode"] = "tui"): ExtensionContext =>
    extensionContextFixture({ mode, hasUI: mode === "tui", ui: { notify: notices } });
  const settle = (context: ExtensionContext, event: AgentBeforeSettleEvent = settleEvent()) => {
    const [handler] = host.handlers.get("agent_before_settle");
    return Promise.resolve(handler?.(event, context));
  };
  const turns = () => sendMessage.mock.calls.map(([, options]) => options?.triggerTurn);
  const wakes = () =>
    sendMessage.mock.calls.filter(([message]) => message.customType === WAKE_MESSAGE_TYPE);
  return {
    ...host,
    wake,
    notify,
    sendMessage,
    drain,
    notices,
    ctx,
    settle,
    turns,
    wakes,
    setIdle: (next: boolean) => {
      idle = next;
    },
    runChecks: () => {
      for (const check of checks.splice(0)) check();
    },
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
        expect(test.notices).toHaveBeenCalledOnce();

        yield* Effect.promise(() => test.emit("input", context, inputEvent("extension")));
        test.notify({ type: "completed", runs: [{ ...completed, generation: 2 }] });

        yield* Effect.promise(() => test.emit("input", context, inputEvent("interactive")));
        test.notify({ type: "completed", runs: [{ ...completed, generation: 3 }] });

        expect(test.turns()).toEqual([false, false, true]);
        yield* Effect.promise(() =>
          test.emit("agent_settled", context, { type: "agent_settled", aborted: false }),
        );
        expect(test.wakes()).toHaveLength(0);
      }),
  );

  it.effect("keeps waking the parent after a run that finished normally", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: false }),
      );
      test.notify({ type: "completed", runs: [completed] });
      expect(test.turns()).toEqual([true]);
    }),
  );

  it.effect("appends notices to a busy parent and continues its run so the model sees them", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      test.notify({ type: "completed", runs: [completed] });
      test.notify({
        type: "question",
        id: "agent-2",
        name: "writer",
        requestId: "q-1",
        message: "Which file?",
        generation: 1,
      });
      expect(test.turns()).toEqual([false, false]);

      const pending = yield* Effect.promise(() =>
        test.settle(test.ctx(), settleEvent("completed", [reply()], [notice()])),
      );
      expect(pending).toMatchObject({ continue: true });

      const appended = yield* Effect.promise(() =>
        test.settle(test.ctx(), settleEvent("completed", [reply(), notice()])),
      );
      expect(appended).toMatchObject({ continue: true });

      const answered = yield* Effect.promise(() =>
        test.settle(test.ctx(), settleEvent("completed", [notice(), reply()])),
      );
      expect(answered).toBeUndefined();

      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: false }),
      );
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("does not continue for notices while wakes are held", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: true }),
      );
      const result = yield* Effect.promise(() =>
        test.settle(test.ctx(), settleEvent("completed", [reply(), notice()])),
      );
      expect(result).toBeUndefined();
    }),
  );

  it.effect("wakes once when a notice arrives after the run's last settle boundary", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      yield* Effect.promise(() => test.settle(test.ctx(), settleEvent("completed", [reply()])));
      test.notify({ type: "completed", runs: [completed] });

      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: false }),
      );
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: false }),
      );
      expect(test.wakes()).toHaveLength(1);
      expect(test.wakes()[0]?.[1]).toMatchObject({ triggerTurn: true });
    }),
  );

  it.effect("does not wake the branch a tree move lands on for a notice owed on the old one", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      yield* Effect.promise(() => test.settle(test.ctx(), settleEvent("completed", [reply()])));
      test.notify({ type: "completed", runs: [completed] });

      yield* Effect.promise(() =>
        test.emit("session_tree", test.ctx(), {
          type: "session_tree",
          newLeafId: "entry-1",
          oldLeafId: "entry-2",
        }),
      );
      yield* Effect.promise(() =>
        test.emit("agent_settled", test.ctx(), { type: "agent_settled", aborted: false }),
      );
      expect(test.wakes()).toHaveLength(0);
    }),
  );

  it.effect("defers the wake for a notice that arrives during a manual compaction", () =>
    Effect.gen(function* () {
      const test = harness();
      test.setIdle(false);
      test.notify({ type: "completed", runs: [completed] });
      expect(test.turns()).toEqual([false]);

      yield* Effect.promise(() =>
        test.emit("session_compact", test.ctx(), {
          type: "session_compact",
          compactionEntry: {
            type: "compaction",
            id: "c-1",
            parentId: null,
            timestamp: "",
            summary: "",
            firstKeptEntryId: "c-1",
            tokensBefore: 0,
          },
          fromExtension: false,
          reason: "manual",
          willRetry: false,
        }),
      );
      test.runChecks();
      expect(test.wakes()).toHaveLength(0);

      test.setIdle(true);
      test.runChecks();
      test.runChecks();
      expect(test.wakes()).toHaveLength(1);
    }),
  );

  it.effect("reminds only about direct-child questions in the service projection", () => {
    const { fake, layer, projections } = localServiceFixture();
    return withService(layer, function* (service) {
      const direct = yield* service.start(request());
      yield* service.startSessionOwnedFrom(direct.id, request());
      const directQuestion = "Which path should the root child take?";
      const nestedQuestion = "Which path should the nested child take?";
      fake.controls[0]!.offerIpc(contactParentFrame("direct-question", "question", directQuestion));
      fake.controls[1]!.offerIpc(contactParentFrame("nested-question", "question", nestedQuestion));
      yield* yieldUntil(
        () => projections.at(-1)?.runs.filter((run) => run.question !== undefined).length === 2,
      );
      const test = harness(yield* service.projection);
      const context = test.ctx();

      const reminder = yield* Effect.promise(() => test.settle(context));
      expect(reminder).toMatchObject({ continue: true });
      expect(reminder?.entries?.[0]).toMatchObject({ content: stringContaining(directQuestion) });
      expect(JSON.stringify(reminder?.entries)).not.toContain(nestedQuestion);

      expect(yield* Effect.promise(() => test.settle(context))).toBeUndefined();
      expect(test.notices).toHaveBeenCalledOnce();
    });
  });

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
      expect(
        yield* Effect.promise(() => test.settle(test.ctx(), settleEvent("aborted"))),
      ).toBeUndefined();
    }),
  );

  it.effect("drains running children before a headless parent settles", () =>
    Effect.gen(function* () {
      const test = harness(projectionOf([view({ state: "running" })]));

      yield* Effect.promise(() => test.settle(test.ctx("tui")));
      expect(test.drain).not.toHaveBeenCalled();

      expect(yield* Effect.promise(() => test.settle(test.ctx("print")))).toBeUndefined();
      expect(test.drain).toHaveBeenCalledOnce();

      test.setProjection(projectionOf([view({ state: "completed" })]));
      yield* Effect.promise(() => test.settle(test.ctx("print")));
      expect(test.drain).toHaveBeenCalledOnce();
    }),
  );

  it.effect("continues a headless parent with the reports delivered while it drained", () =>
    Effect.gen(function* () {
      const test = harness(projectionOf([view({ state: "running" })]));
      test.setIdle(false);
      test.drain.mockImplementationOnce(() => {
        test.notify({ type: "completed", runs: [completed] });
        return Promise.resolve();
      });

      const result = yield* Effect.promise(() => test.settle(test.ctx("print")));
      expect(result).toMatchObject({ continue: true });
      expect(test.turns()).toEqual([false]);
    }),
  );
});
