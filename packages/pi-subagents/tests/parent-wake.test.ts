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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

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
  const turns = () => Arr.map(sendMessage.mock.calls, ([, options]) => options?.triggerTurn);
  const wakes = () =>
    Arr.filter(sendMessage.mock.calls, ([message]) => message.customType === WAKE_MESSAGE_TYPE);
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

  it.effect("holds a notice behind an open dialog and wakes the parent once it closes", () =>
    Effect.gen(function* () {
      const test = harness();
      const context = test.ctx();
      const dialog = { reason: "ui_prompt", kind: "confirm" } as const;
      yield* Effect.promise(() =>
        test.emit("ui_prompt_start", context, { type: "ui_prompt_start", ...dialog }),
      );
      expect(test.wake.deliver(() => true)).toBe("held");
      expect(test.wakes()).toHaveLength(0);

      yield* Effect.promise(() =>
        test.emit("ui_prompt_end", context, { type: "ui_prompt_end", ...dialog }),
      );
      expect(test.wakes()).toHaveLength(1);
      expect(test.wakes()[0]?.[1]).toMatchObject({ triggerTurn: true });
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

  it.effect("reminds only about direct-child questions in the service projection", () => {
    const { fake, layer, projections } = localServiceFixture();
    return withService(layer, function* (service) {
      const direct = yield* service.start(request());
      yield* service.startSessionOwnedFrom(direct.id, request());
      const directQuestion = "Which path should the root child take?";
      const nestedQuestion = "Which path should the nested child take?";
      fake.controls[0]!.offerIpc(contactParentFrame("direct-question", "question", directQuestion));
      fake.controls[1]!.offerIpc(contactParentFrame("nested-question", "question", nestedQuestion));
      yield* yieldUntil(() =>
        Option.exists(
          Arr.last(projections),
          (projection) =>
            Arr.filter(projection.runs, (run) => run.question !== undefined).length === 2,
        ),
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

  for (const mode of ["print"] as const) {
    it.effect(`continues ${mode} drain for a question blocked behind nested delivery`, () => {
      const test = harness();
      test.setIdle(false);
      const { fake, layer, notifications } = localServiceFixture({
        publish: test.setProjection,
        notify: test.notify,
      });
      return withService(layer, function* (service) {
        test.drain.mockImplementation(() => Effect.runPromise(service.awaitParentDrain));
        const parent = yield* service.start(request({ name: "nested-parent" }));
        yield* service.startSessionOwnedFrom(parent.id, request({ name: "nested-child" }));
        const asking = yield* service.start(request({ name: "root-child" }));
        const deliveryGate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(deliveryGate, undefined));
        fake.controls[0]?.gateNextIpcType("proxy_notification", deliveryGate);
        fake.controls[1]?.offerIpc(
          contactParentFrame("nested-question", "question", "Question for the nested parent."),
        );
        yield* yieldUntil(() => fake.controls[0]?.sentIpc("proxy_notification") === true);
        const settling = yield* Effect.promise(() => test.settle(test.ctx(mode))).pipe(
          Effect.forkScoped,
        );
        yield* yieldUntil(() => test.drain.mock.calls.length > 0);
        const question = "Question for the root parent.";
        fake.controls[2]?.offerIpc(contactParentFrame("root-question", "question", question));

        const result = yield* Fiber.join(settling);
        expect(result).toMatchObject({ continue: true });
        expect(JSON.stringify(result?.entries)).toContain(question);
        const rootNotifications = () =>
          Arr.filter(notifications, (item) => item.type === "question" && item.id === asking.id);
        expect(rootNotifications()).toEqual([]);
        expect(test.sendMessage).not.toHaveBeenCalled();
        // A reminder is not a notifier acknowledgement. An already-reminded question must not
        // cause either another continuation or an indefinite drain on the still-running sibling.
        expect(yield* Effect.promise(() => test.settle(test.ctx(mode)))).toBeUndefined();

        yield* Deferred.succeed(deliveryGate, undefined);
        yield* yieldUntil(() => rootNotifications().length === 1);
        yield* TestClock.adjust("1 second");
        expect(rootNotifications()).toHaveLength(1);
        expect(test.turns()).toEqual([false]);
        expect(yield* Effect.promise(() => test.settle(test.ctx(mode)))).toBeUndefined();
      });
    });
  }
});
