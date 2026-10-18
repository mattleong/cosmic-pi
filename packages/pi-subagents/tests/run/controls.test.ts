import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  askParent,
  localServiceFixture,
  request,
  nativeReportRequest,
  nativeReportServiceFixture,
  withService,
} from "./fixtures/service-harness.ts";
import { anyString } from "../support/matchers.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";

describe("SubagentService", () => {
  it.effect("renames any running run's display name in the root alone", () => {
    const { backend, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.startSessionOwned(nativeReportRequest({ name: "first-name" }));
      expect((yield* service.rename(run.id, "  second-name  ")).name).toBe("second-name");
      expect(yield* service.status(run.id)).toMatchObject({
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
        type: "supervisor_question_cancelled",
        assignmentEpoch: 1,
        requestId: "question-cancelled",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      expect(yield* service.status(run.id)).toMatchObject({
        state: "running",
        question: undefined,
      });
    });
  });

  it.effect("routes blocking child questions and peer notices through supervisor IPC", () => {
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

      const waiting = yield* service.status(first.id);
      expect(waiting.question?.message).toBe("Which API should I use?");
      const replied = yield* service.send(first.id, "Use the public API.");
      expect(replied).toMatchObject({ delivery: "answered", run: { state: "running" } });
      expect(fake.controls[0]?.ipc).toContainEqual({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: "question-1",
        ackId: anyString(),
        message: "Use the public API.",
      });

      yield* service.start(request({ name: "reader-two", task: "Review tests" }));
      expect(
        fake.controls[0]?.sentIpc("peer_notice", (notice) => notice.message.includes("reader-two")),
      ).toBe(true);
    });
  });

  it.effect("answers a waiting child and steers a running sibling with one message", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const asking = yield* service.start(request({ name: "asking" }));
      const working = yield* service.start(request({ name: "working", task: "Review tests" }));
      yield* askParent(fake.controls[0]!, projections, "question-1");
      expect((yield* service.status(working.id)).state).toBe("running");

      const outcomes = yield* Effect.forEach(
        [asking.id, working.id],
        (id) => service.send(id, "Use the public API."),
        { concurrency: 2 },
      );
      expect(outcomes).toMatchObject([
        { delivery: "answered", run: { id: asking.id, state: "running" } },
        { delivery: "guided", run: { id: working.id, state: "running" } },
      ]);
      expect(fake.controls[0]?.sentIpc("parent_reply")).toBe(true);
      expect(fake.controls[0]?.sent("steer")).toBe(false);
      expect(fake.controls[1]?.sentIpc("parent_reply")).toBe(false);
      expect(fake.controls[1]?.sent("steer")).toBe(true);
    });
  });

  it.effect("refuses another message while a parent reply is in flight", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "reply-in-flight" }));
      yield* askParent(fake.controls[0]!, projections, "question-in-flight");
      const replyGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpcType("parent_reply", replyGate);
      const replying = yield* service
        .send(run.id, "Proceed.")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => fake.controls[0]?.sentIpc("parent_reply") === true);

      expect(yield* service.send(run.id, "Proceed again.").pipe(Effect.flip)).toMatchObject({
        code: "reply_in_flight",
      });
      expect(fake.controls[0]?.sent("steer")).toBe(false);

      yield* Deferred.succeed(replyGate, undefined);
      expect(yield* Fiber.join(replying)).toMatchObject({ delivery: "answered" });
      expect(
        fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply"),
      ).toHaveLength(1);
    });
  });

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
          delivery: "guided",
          run: { state: "running" },
        });
        expect(yield* Fiber.join(sendingSecond)).toMatchObject({
          delivery: "guided",
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
      expect((yield* service.status(run.id)).state).toBe("paused");
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
      const guidanceFailure = yield* Effect.flip(service.send(run.id, "Continue."));
      expect(guidanceFailure.message).toContain(
        `subagent_lifecycle({ action: "resume", runIds: ["${run.id}"] })`,
      );

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

  it.effect("rolls back a definitely unsent reply and keeps the question answerable", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "unsent-reply" }));
      yield* askParent(fake.controls[0]!, projections, "unsent-question");

      fake.controls[0]?.failNextIpc("transport_not_sent");
      expect(yield* service.send(run.id, "Proceed.").pipe(Effect.flip)).toMatchObject({
        code: "reply_send_failed",
      });
      const status = yield* service.status(run.id);
      expect(status.state).toBe("waiting_for_parent");
      expect(status.question).toMatchObject({ requestId: "unsent-question" });
      expect(status.warning).toBeUndefined();

      expect(yield* service.send(run.id, "Proceed.")).toMatchObject({
        delivery: "answered",
        run: { state: "running" },
      });
      expect(fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply")).toEqual([
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "unsent-question",
          ackId: anyString(),
          message: "Proceed.",
        },
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "unsent-question",
          ackId: anyString(),
          message: "Proceed.",
        },
      ]);
    });
  });

  it.effect("rejects oversized parent messages before transport", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "bounded-message" }));
      const failure = yield* Effect.flip(service.send(run.id, "x".repeat(64 * 1024 + 1)));
      expect(failure._tag).toBe("InvalidSubagentRequestError");
      expect(fake.controls[0]?.sent("steer")).toBe(false);
    });
  });
});
