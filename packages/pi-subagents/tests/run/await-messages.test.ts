import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { type AgentCaller, MAIN_AGENT_ID } from "../../src/run/agent-messaging.ts";
import type { AgentMessageArrivals } from "../../src/run/message-watches.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import { fakeAgentMain } from "./fixtures/agent-main.ts";
import {
  completeLocalRun,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

const MAIN: AgentCaller = { kind: "main" };
const asRun = (run: SubagentRunView): AgentCaller => ({ kind: "run", runId: run.id });
const nesting = { maxDirectChildren: 12, maxDepth: 3 };

const summarize = (
  observations: ReadonlyArray<SubagentRunObservation>,
  _questions: ReadonlyArray<SubagentRunView> = [],
  messages?: AgentMessageArrivals,
) =>
  Effect.succeed({
    targets: Arr.map(observations, ({ run, completionReceipt }) => ({
      id: run.id,
      state: run.state,
      receipt: completionReceipt !== undefined,
    })),
    messages: {
      count: messages?.count ?? 0,
      from: Arr.map(messages?.arrivals ?? [], (arrival) => arrival.from),
      text: Arr.map(messages?.arrivals ?? [], (arrival) => arrival.text),
    },
  });

const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 25; turn += 1) yield* Effect.yieldNow;
});

describe("await and agent messages to the waiting agent", () => {
  it.effect("ends a root wait when a descendant messages main, and a new wait starts fresh", () => {
    const main = fakeAgentMain({ state: "busy" });
    const { fake, layer } = localServiceFixture({ agentMain: main.capabilities });
    return withService(layer, function* (service) {
      const awaited = yield* service.start(request({ name: "awaited", nestingPolicy: nesting }));
      const deep = yield* service.startSessionOwnedFrom(
        awaited.id,
        request({ name: "deep", nestingPolicy: nesting }),
      );
      const waiting = yield* service
        .withAwaitTerminalObservations([awaited.id], "all_finished", undefined, summarize)
        .pipe(Effect.forkScoped);
      yield* yieldTurns;

      yield* service.agentSend(asRun(deep), MAIN_AGENT_ID, "The schema moved.");
      expect(yield* Fiber.join(waiting)).toEqual({
        targets: [{ id: awaited.id, state: "running", receipt: false }],
        messages: { count: 1, from: [deep.id], text: ["The schema moved."] },
      });
      expect(main.delivered).toHaveLength(1);

      // The ended wait released its claim, and the earlier message doesn't end the next one.
      const again = yield* service
        .withAwaitTerminalObservations([awaited.id], "all_finished", undefined, summarize)
        .pipe(Effect.forkScoped);
      yield* yieldTurns;
      expect(again.pollUnsafe()).toBeUndefined();
      yield* completeLocalRun(service, fake.controls[0]!, awaited.id, "Report.");
      expect(yield* Fiber.join(again)).toEqual({
        targets: [{ id: awaited.id, state: "completed", receipt: true }],
        messages: { count: 0, from: [], text: [] },
      });
    });
  });

  it.effect("keeps waiting through messages to other agents and messages sent before it", () => {
    const main = fakeAgentMain({ state: "busy" });
    const { layer } = localServiceFixture({ agentMain: main.capabilities });
    return withService(layer, function* (service) {
      const awaited = yield* service.start(request({ name: "awaited" }));
      const peer = yield* service.start(request({ name: "peer" }));
      const other = yield* service.start(request({ name: "other" }));
      yield* service.agentSend(asRun(peer), MAIN_AGENT_ID, "Sent before the wait.");
      const waiting = yield* service
        .withAwaitTerminalObservations([awaited.id], "all_finished", undefined, summarize)
        .pipe(Effect.forkScoped);
      yield* yieldTurns;

      for (const [caller, to] of [
        [asRun(peer), other.id],
        [asRun(peer), awaited.id],
        [MAIN, other.id],
        [MAIN, awaited.id],
      ] as const)
        expect((yield* service.agentSend(caller, to, "Not for main.")).disposition).toBe("guided");
      yield* yieldTurns;
      expect(waiting.pollUnsafe()).toBeUndefined();

      yield* service.agentSend(asRun(other), MAIN_AGENT_ID, "For main.");
      expect((yield* Fiber.join(waiting)).messages).toEqual({
        count: 1,
        from: [other.id],
        text: ["For main."],
      });
    });
  });

  it.effect("ends a nested parent's wait when its descendant messages it, not main's", () => {
    const main = fakeAgentMain({ state: "busy" });
    const { fake, layer } = localServiceFixture({ agentMain: main.capabilities });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent", nestingPolicy: nesting }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "child", nestingPolicy: nesting }),
      );
      const grandchild = yield* service.startSessionOwnedFrom(
        child.id,
        request({ name: "grandchild", nestingPolicy: nesting }),
      );
      const rootWait = yield* service
        .withAwaitTerminalObservations([parent.id], "all_finished", undefined, summarize)
        .pipe(Effect.forkScoped);
      const nestedWait = yield* service
        .withAwaitTerminalObservations([child.id], "all_finished", undefined, summarize, parent.id)
        .pipe(Effect.forkScoped);
      yield* yieldTurns;

      yield* service.agentSend(asRun(grandchild), parent.id, "Found the race.");
      expect(yield* Fiber.join(nestedWait)).toEqual({
        targets: [{ id: child.id, state: "running", receipt: false }],
        messages: { count: 1, from: [grandchild.id], text: ["Found the race."] },
      });
      // The message reached the parent's turn before its wait returned.
      expect(
        Arr.some(
          fake.controls[0]!.commands,
          (command) =>
            command.type === "prompt" &&
            command.streamingBehavior === "steer" &&
            Fn.pipe(command.message, Str.includes("Found the race.")),
        ),
      ).toBe(true);
      yield* yieldTurns;
      expect(rootWait.pollUnsafe()).toBeUndefined();
    });
  });
});
