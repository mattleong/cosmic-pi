import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import { localServiceFixture, request, withService } from "./fixtures/service-harness.ts";

const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 25; turn += 1) yield* Effect.yieldNow;
});

const reportOf = (notifications: ReadonlyArray<SubagentNotification>) =>
  notifications.flatMap((notification) =>
    notification.type === "completed" ? notification.runs.map((run) => run.finalText) : [],
  );

describe("guidance that reaches a finishing local Pi child", () => {
  it.effect("starts a new child turn when guidance arrives while settlement is pending", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "late-guidance" }));
      const control = fake.controls[0]!;
      const stats = control.commandTypes("get_session_stats").length;
      const statsGate = yield* Deferred.make<void>();
      control.gateNextSend("get_session_stats", statsGate);
      control.settle("Old report.");
      yield* yieldUntil(() => control.commandTypes("get_session_stats").length > stats);

      control.answerNextGuidance("started");
      expect((yield* service.send(run.id, "Also check the lexer.")).run.state).toBe("running");
      expect(control.commands.at(-1)).toMatchObject({
        type: "prompt",
        message: "Also check the lexer.",
        streamingBehavior: "steer",
      });
      yield* Deferred.succeed(statsGate, undefined);
      yield* yieldTurns;
      expect((yield* service.status(run.id)).state).toBe("running");

      control.offer({ type: "agent_start" });
      control.settle("New report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(reportOf(notifications)).toEqual(["New report."]);
    });
  });

  it.effect("drops a settlement the guidance made stale after the run received it", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "restarted-child" }));
      const control = fake.controls[0]!;
      const steerGate = yield* Deferred.make<void>();
      control.gateNextSend("steer", steerGate);
      control.answerNextGuidance("started");
      const sending = yield* service
        .send(run.id, "Also check the lexer.")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => control.sent("steer"));

      const stats = control.commandTypes("get_session_stats").length;
      control.settle("Old report.");
      yield* yieldUntil(() => control.commandTypes("get_session_stats").length > stats);
      yield* yieldTurns;
      expect((yield* service.status(run.id)).state).toBe("running");

      yield* Deferred.succeed(steerGate, undefined);
      expect((yield* Fiber.join(sending)).run.state).toBe("running");
      yield* yieldTurns;
      expect((yield* service.status(run.id)).state).toBe("running");

      control.offer({ type: "agent_start" });
      control.settle("New report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(reportOf(notifications)).toEqual(["New report."]);
    });
  });

  it.effect("fails guidance that the child handled before it reached the model", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "handled-guidance" }));
      fake.controls[0]!.answerNextGuidance("handled");

      const failure = yield* service.send(run.id, "/compact").pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "guidance_not_delivered" });
      const { state, sessionEvents } = yield* service.status(run.id);
      expect(state).toBe("running");
      expect(sessionEvents.some((event) => event.type === "notice")).toBe(false);
    });
  });
});
