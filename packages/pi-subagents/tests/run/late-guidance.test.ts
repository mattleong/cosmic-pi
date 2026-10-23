import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import { gatedReportArchive } from "./fixtures/run-context.ts";
import { localServiceFixture, request, runView, withService } from "./fixtures/service-harness.ts";
import * as Arr from "effect/Array";

const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 25; turn += 1) yield* Effect.yieldNow;
});

const reportOf = (notifications: ReadonlyArray<SubagentNotification>) =>
  Arr.flatMap(notifications, (notification) =>
    notification.type === "completed" ? Arr.map(notification.runs, (run) => run.finalText) : [],
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
      expect(yield* service.send(run.id, "Also check the lexer.")).toMatchObject({
        run: { state: "running" },
      });
      expect(control.commands.at(-1)).toMatchObject({
        type: "prompt",
        message: "Also check the lexer.",
        streamingBehavior: "steer",
      });
      yield* Deferred.succeed(statsGate, undefined);
      yield* yieldTurns;
      expect((yield* runView(service, run.id)).state).toBe("running");

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
      expect((yield* runView(service, run.id)).state).toBe("running");

      yield* Deferred.succeed(steerGate, undefined);
      expect(yield* Fiber.join(sending)).toMatchObject({ run: { state: "running" } });
      yield* yieldTurns;
      expect((yield* runView(service, run.id)).state).toBe("running");

      control.offer({ type: "agent_start" });
      control.settle("New report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(reportOf(notifications)).toEqual(["New report."]);
    });
  });

  // A report's file is saved inside its settlement's locked transition, so input arriving
  // meanwhile waits for the settlement instead of racing it.
  it.effect("refuses guidance sent while the report file is saved once the report settles", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { fake, notifications, layer } = localServiceFixture({ archiveReport: gate.archive });
      return yield* withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "archiving-child" }));
        const control = fake.controls[0]!;
        control.settle("Old report.");
        yield* Deferred.await(gate.entered);
        const prompts = control.commandTypes("prompt").length;

        control.answerNextGuidance("started");
        const sending = yield* service
          .send(run.id, "Also check the lexer.")
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* yieldTurns;
        yield* Deferred.succeed(gate.release, undefined);

        // No restarted turn exists for the old report to abandon.
        expect(yield* Fiber.join(sending)).toMatchObject({ code: "agent_unavailable" });
        expect(control.commandTypes("prompt")).toHaveLength(prompts);
        expect(yield* runView(service, run.id)).toMatchObject({
          state: "completed",
          finalText: "Old report.",
          reportArchive: { path: "/archive/1.md" },
        });
        expect(gate.discarded).toEqual([]);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 1);
        expect(reportOf(notifications)).toEqual(["Old report."]);
      });
    }),
  );

  it.effect("doesn't acknowledge a pause requested while the report file is saved", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { fake, layer } = localServiceFixture({ archiveReport: gate.archive });
      return yield* withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "paused-while-archiving" }));
        fake.controls[0]!.settle("Old report.");
        yield* Deferred.await(gate.entered);

        const pausing = yield* service
          .interrupt(run.id)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* yieldTurns;
        yield* Deferred.succeed(gate.release, undefined);

        expect(yield* Fiber.join(pausing)).toMatchObject({ code: "interrupt_state_invalid" });
        expect(yield* runView(service, run.id)).toMatchObject({
          state: "completed",
          finalText: "Old report.",
          reportArchive: { path: "/archive/1.md" },
        });
        expect(gate.discarded).toEqual([]);
      });
    }),
  );

  it.effect("keeps the report when handled guidance and a backend failure meet its file save", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { fake, notifications, layer } = localServiceFixture({ archiveReport: gate.archive });
      return yield* withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "failing-while-archiving" }));
        const control = fake.controls[0]!;
        control.settle("Old report.");
        yield* Deferred.await(gate.entered);

        control.answerNextGuidance("handled");
        const sending = yield* service
          .send(run.id, "/compact")
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* yieldTurns;
        control.failExit("transport read failed");
        yield* yieldTurns;
        yield* Deferred.succeed(gate.release, undefined);

        expect(yield* Fiber.join(sending)).toMatchObject({ code: "agent_unavailable" });
        yield* yieldTurns;
        expect(yield* runView(service, run.id)).toMatchObject({
          state: "completed",
          finalText: "Old report.",
          reportArchive: { path: "/archive/1.md" },
        });
        expect(gate.discarded).toEqual([]);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 1);
        expect(reportOf(notifications)).toEqual(["Old report."]);
      });
    }),
  );

  it.effect("fails guidance that the child handled before it reached the model", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "handled-guidance" }));
      fake.controls[0]!.answerNextGuidance("handled");

      const failure = yield* service.send(run.id, "/compact").pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "guidance_not_delivered" });
      const { state, sessionEvents } = yield* runView(service, run.id);
      expect(state).toBe("running");
      expect(Arr.some(sessionEvents, (event) => event.type === "notice")).toBe(false);
    });
  });
});
