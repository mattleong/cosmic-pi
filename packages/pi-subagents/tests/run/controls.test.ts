import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  askParent,
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

describe("SubagentService", () => {
  it.effect("renames any running run's display name in the root alone", () => {
    const { backend, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.startSessionOwned(nativeReportRequest({ name: "first-name" }));
      expect((yield* service.rename(run.id, "  second-name  ")).name).toBe("second-name");
      expect(yield* runView(service, run.id)).toMatchObject({
        state: "running",
        name: "second-name",
      });
      expect(backend.controls).toHaveLength(1);
      expect(yield* service.rename(run.id, "   ").pipe(Effect.flip)).toBeInstanceOf(
        InvalidSubagentRequestError,
      );
    });
  });

  it.effect("clears a waiting parent question when its MCP caller cancels", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.startSessionOwned(
        nativeReportRequest({ name: "cancelled-question" }),
      );
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "question-cancelled",
        kind: "question",
        message: "Should this continue?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      backend.controls[0]?.offer({
        type: "parent_question_cancelled",
        assignmentEpoch: 1,
        requestId: "question-cancelled",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      expect(yield* runView(service, run.id)).toMatchObject({
        state: "running",
        question: undefined,
      });
    });
  });

  it.effect(
    "routes child dialogs, blocking questions, and peer notices through supervisor IPC",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const first = yield* service.start(request({ name: "reader-one" }));
        fake.controls[0]?.offer({
          type: "extension_ui_request",
          id: "dialog-1",
          method: "confirm",
        });
        yield* yieldUntil(() => fake.controls[0]?.sent("extension_ui_response") === true);
        expect(fake.controls[0]?.commands).toContainEqual({
          type: "extension_ui_response",
          id: "dialog-1",
          cancelled: true,
        });
        yield* askParent(fake.controls[0]!, projections, "question-1", "Which API should I use?");
        expect((yield* runView(service, first.id)).question?.message).toBe(
          "Which API should I use?",
        );

        yield* service.start(request({ name: "reader-two", task: "Review tests" }));
        expect(
          fake.controls[0]?.sentIpc("peer_notice", (notice) =>
            Fn.pipe(notice.message, Str.includes("reader-two")),
          ),
        ).toBe(true);
      });
    },
  );

  it.effect(
    "finishes admitted guidance before queue clearing and rejects guidance admitted after interrupt",
    () => {
      const { fake, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "steer-before-interrupt" }));
        const steerGate = yield* Deferred.make<void>();
        const clearGate = yield* Deferred.make<void>();
        fake.controls[0]?.gateNextSend("steer", steerGate);
        fake.controls[0]?.gateNextSend("clear_queue", clearGate);

        const sending = yield* service
          .send(run.id, "Finish this guidance.")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* yieldUntil(() => fake.controls[0]?.sent("steer") === true);
        const sendingSecond = yield* service
          .send(run.id, "Finish the other admitted guidance too.")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        const interrupting = yield* service
          .interrupt(run.id)
          .pipe(Effect.forkScoped({ startImmediately: true }));

        const rejected = yield* service.send(run.id, "Too late.").pipe(Effect.flip);
        expect(rejected).toBeInstanceOf(InvalidSubagentRequestError);
        expect(rejected).toMatchObject({ code: "interrupt_in_flight" });
        expect(fake.controls[0]?.sent("clear_queue")).toBe(false);

        yield* Deferred.succeed(steerGate, undefined);
        expect(yield* Fiber.join(sending)).toMatchObject({
          disposition: "guided",
          run: { state: "running" },
        });
        expect(yield* Fiber.join(sendingSecond)).toMatchObject({
          disposition: "guided",
          run: { state: "running" },
        });
        yield* yieldUntil(() => fake.controls[0]?.sent("clear_queue") === true);
        expect(fake.controls[0]?.commandTypes("steer", "clear_queue", "abort")).toEqual([
          "steer",
          "steer",
          "clear_queue",
        ]);

        yield* Deferred.succeed(clearGate, undefined);
        expect((yield* Fiber.join(interrupting)).state).toBe("paused");
        expect(fake.controls[0]?.commandTypes("steer", "clear_queue", "abort")).toEqual([
          "steer",
          "steer",
          "clear_queue",
          "abort",
        ]);
      });
    },
  );

  it.effect("finishes an accepted interrupt after its requesting fiber is cancelled", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "cancelled-interrupt-request" }));
      const gate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("clear_queue", gate);
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(() => fake.controls[0]?.sent("clear_queue") === true);
      yield* Fiber.interrupt(interrupting);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "paused");
      expect((yield* runView(service, run.id)).state).toBe("paused");
    });
  });

  it.effect("clears a pending question when settlement wins the interrupt race", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "question-pause" }));
      yield* askParent(fake.controls[0]!, projections, "question-before-pause");
      fake.controls[0]?.beforeNextResponse("abort", { type: "agent_settled" });

      const paused = yield* service.interrupt(run.id);
      expect(paused.state).toBe("paused");
      expect(paused.question).toBeUndefined();
      expect(yield* service.send(run.id, "Continue.").pipe(Effect.flip)).toMatchObject({
        code: "agent_unavailable",
      });

      const resumed = yield* service.resume(run.id);
      expect(resumed.state).toBe("running");
      expect(resumed.question).toBeUndefined();
    });
  });

  it.effect("finishes stop cleanup after the requesting fiber is interrupted", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "cancel-safe-stop" }));
      const releaseGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateRelease(releaseGate);
      const stopping = yield* service.stop(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopping");
      yield* Fiber.interrupt(stopping);
      yield* Deferred.succeed(releaseGate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
      expect(fake.controls[0]?.released()).toBe(1);
    });
  });

  it.effect("rejects a parent reply after interruption claims the waiting run", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "pause-before-reply" }));
      yield* askParent(fake.controls[0]!, projections, "question-before-pause");
      const barrierGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpcType("turn_input_barrier", barrierGate);
      const interrupting = yield* service
        .interrupt(run.id)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => fake.controls[0]?.sentIpc("turn_input_barrier") === true);

      const rejected = yield* service.send(run.id, "Continue.").pipe(Effect.flip);
      expect(rejected).toBeInstanceOf(InvalidSubagentRequestError);
      expect(rejected).toMatchObject({ code: "interrupt_in_flight" });

      yield* Deferred.succeed(barrierGate, undefined);
      expect((yield* Fiber.join(interrupting)).state).toBe("paused");
      expect(fake.controls[0]?.sentIpc("parent_reply")).toBe(false);
    });
  });
});
