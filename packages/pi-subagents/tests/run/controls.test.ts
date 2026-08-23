// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  fakeChildLayer,
  fakeRetainedBackendLayer,
  request,
  retainedServiceLayer,
  serviceLayer,
} from "./fixtures/service-harness.ts";

describe("SubagentService", () => {
  it.effect("clears a waiting parent question when its MCP caller cancels", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => void projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.startSessionOwned(
        request({
          name: "cancelled-question",
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("routes blocking child questions and peer notices through supervisor IPC", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "reader-one" }));
      fake.controls[0]?.offer({
        type: "extension_ui_request",
        id: "dialog-1",
        method: "confirm",
      });
      yield* yieldUntil(
        () =>
          fake.controls[0]?.commands.some((command) => command.type === "extension_ui_response") ??
          false,
      );
      expect(fake.controls[0]?.commands).toContainEqual({
        type: "extension_ui_response",
        id: "dialog-1",
        cancelled: true,
      });
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which API should I use?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");

      const waiting = yield* service.status(first.id);
      expect(waiting.question?.message).toBe("Which API should I use?");
      const guidanceFailure = yield* Effect.flip(service.send(first.id, "Use the public API."));
      expect(guidanceFailure.message).toContain(
        `subagent_reply({ runId: "${first.id}", message: "..." })`,
      );
      const replied = yield* service.reply(first.id, "Use the public API.");
      expect(replied.state).toBe("running");
      expect(fake.controls[0]?.ipc).toContainEqual({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: "question-1",
        message: "Use the public API.",
      });

      yield* service.start(request({ name: "reader-two", task: "Review tests" }));
      expect(
        fake.controls[0]?.ipc.some(
          (message) => message.type === "peer_notice" && message.message.includes("reader-two"),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("finishes an accepted interrupt after its requesting fiber is cancelled", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancelled-interrupt-request" }));
      const gate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("abort", gate);
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "abort") ?? false,
      );
      yield* Fiber.interrupt(interrupting);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "paused");
      expect((yield* service.status(run.id)).state).toBe("paused");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("finishes an accepted resume after its requesting fiber is cancelled", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancelled-resume-request" }));
      expect((yield* service.interrupt(run.id)).state).toBe("paused");

      const gate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("prompt", gate);
      const resuming = yield* service.resume(run.id, "Continue safely.").pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
      yield* Fiber.interrupt(resuming);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      const resumed = yield* service.status(run.id);
      expect(resumed.sessionEvents).toContainEqual(
        expect.objectContaining({
          type: "notice",
          kind: "parent",
          text: "Resume: Continue safely.",
        }),
      );
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("clears a pending question when settlement wins the interrupt race", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "question-pause" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-before-pause",
        kind: "question",
        message: "Should I continue?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("ignores child settlement that arrives after interruption is confirmed", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "settled-after-pause" }));
      expect((yield* service.interrupt(run.id)).state).toBe("paused");

      fake.controls[0]?.offer({ type: "agent_settled" });
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      expect(yield* service.status(run.id)).toMatchObject({
        state: "paused",
        reportGeneration: 0,
      });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps a timed-out interrupt pending until child settlement", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "late-pause" }));
      fake.controls[0]?.dropNext("abort");
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "abort") ?? false,
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(interrupting).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "SubagentProcessError",
        code: "interrupt_outcome_uncertain",
      });
      expect(error.message).toContain("may still apply");
      expect(error.message).toContain("subagent_status");

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "paused");
      expect((yield* service.status(run.id)).state).toBe("paused");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("fails when the IPC boundary rejects a malformed contact event", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "ipc-boundary" }));
      fake.controls[0]?.offerProtocolError("Subagent emitted an invalid parent-contact event.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect((yield* service.status(run.id)).state).toBe("failed");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("fails an in-flight RPC promptly when stop sweeps its registration", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "stop-rpc" }));
      const sendGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", sendGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );
      expect((yield* service.stop(run.id)).state).toBe("stopped");
      const error = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "SubagentProcessError", operation: "stop" });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("fails an in-flight RPC promptly when the run protocol fails", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "failed-rpc" }));
      const sendGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", sendGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      const error = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(error._tag).toBe("SubagentProtocolError");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("finishes stop cleanup after the requesting fiber is interrupted", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancel-safe-stop" }));
      const releaseGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateRelease(releaseGate);
      const stopping = yield* service.stop(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopping");
      yield* Fiber.interrupt(stopping);
      yield* Deferred.succeed(releaseGate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
      expect(fake.controls[0]?.released()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("ignores a parent question that arrives after interruption", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "late-question" }));
      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "late-question",
        kind: "question",
        message: "Too late?",
      });
      yield* Effect.yieldNow;
      const paused = yield* service.status(run.id);
      expect(paused.state).toBe("paused");
      expect(paused.question).toBeUndefined();
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("claims a parent question before sending its reply", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "single-reply" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which answer?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      const ipcGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpc(ipcGate);
      const first = yield* service.reply(run.id, "First").pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      const second = yield* Effect.flip(service.reply(run.id, "Second"));
      expect(second._tag).toBe("InvalidSubagentRequestError");
      yield* Deferred.succeed(ipcGate, undefined);
      expect((yield* Fiber.join(first)).state).toBe("running");
      expect(fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply")).toEqual([
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "question-1",
          message: "First",
        },
      ]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("finishes a delivered parent reply after the requesting fiber is interrupted", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancel-safe-reply" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which answer?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      const ipcGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpc(ipcGate);
      const replying = yield* service.reply(run.id, "First").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.ipc.some((message) => message.type === "parent_reply") ?? false,
      );

      yield* Fiber.interrupt(replying);
      const claimed = yield* service.status(run.id);
      expect(claimed.state).toBe("running");
      expect(claimed.question).toBeUndefined();
      expect((yield* Effect.flip(service.reply(run.id, "Second")))._tag).toBe(
        "InvalidSubagentRequestError",
      );

      yield* Deferred.succeed(ipcGate, undefined);
      yield* yieldUntil(() =>
        Boolean(
          projections
            .at(-1)
            ?.runs[0]?.sessionEvents.some(
              (event) => event.type === "notice" && event.text.includes("Reply: First"),
            ),
        ),
      );
      expect(
        fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply"),
      ).toHaveLength(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("rejects guidance that a parent reply claimed mid-transport", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "steer-vs-reply" }));

      // Hold the steer transport open: `send` is past its guards but has recorded nothing.
      const steerGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", steerGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );

      // A question arrives and the parent claims it while that steer is still in flight.
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which answer?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      const replyGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpc(replyGate);
      const replying = yield* service.reply(run.id, "Answer").pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");

      // The run is "running" again, so only the reply claim can reject the guidance.
      yield* Deferred.succeed(steerGate, undefined);
      const failure = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "guidance_outcome_uncertain",
      });
      expect(failure.message).toContain("may already have applied");
      expect(failure.message).toContain("subagent_status");

      yield* Deferred.succeed(replyGate, undefined);
      expect((yield* Fiber.join(replying)).state).toBe("running");
      const { sessionEvents } = yield* service.status(run.id);
      const notices = sessionEvents.filter((event) => event.type === "notice");
      expect(notices.some((event) => event.text.includes("Guidance:"))).toBe(false);
      expect(notices.some((event) => event.text.includes("Reply: Answer"))).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "maps ambiguous send, reply, interrupt, and resume outcomes without unsafe rollback",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ name: "uncertain-controls" }));

        fake.controls[0]?.failTransportNext("steer", "transport_outcome_uncertain");
        const sendFailure = yield* service.send(run.id, "Potential guidance.").pipe(Effect.flip);
        expect(sendFailure).toMatchObject({ code: "guidance_outcome_uncertain" });
        expect((yield* service.status(run.id)).state).toBe("running");

        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "uncertain-question",
          kind: "question",
          message: "Apply this?",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
        fake.controls[0]?.failNextIpc("transport_outcome_uncertain");
        const replyFailure = yield* service.reply(run.id, "Yes.").pipe(Effect.flip);
        expect(replyFailure).toMatchObject({ code: "reply_outcome_uncertain" });
        expect((yield* service.status(run.id)).state).toBe("running");
        expect(
          (yield* service.reply(run.id, "Do not duplicate.").pipe(Effect.flip)).message,
        ).toContain("no pending parent question");
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "uncertain-question",
          kind: "question",
          message: "Duplicate request ID",
        });
        yield* Effect.yieldNow;
        expect((yield* service.status(run.id)).state).toBe("running");

        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "authoritative-new-question",
          kind: "question",
          message: "A distinct next request?",
        });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs.some(
                (candidate) => candidate.id === run.id && candidate.state === "waiting_for_parent",
              ),
          ),
        );
        expect((yield* service.reply(run.id, "Resolved.")).state).toBe("running");

        const interruptRun = yield* service.start(request({ name: "uncertain-interrupt" }));
        fake.controls[1]?.dropNext("abort");
        const interrupting = yield* service.interrupt(interruptRun.id).pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(interrupting).pipe(Effect.flip)).toMatchObject({
          code: "interrupt_outcome_uncertain",
        });

        const resumeRun = yield* service.start(request({ name: "uncertain-resume" }));
        expect((yield* service.interrupt(resumeRun.id)).state).toBe("paused");
        fake.controls[2]?.failTransportNext("prompt", "transport_outcome_uncertain");
        const resumeFailure = yield* service
          .resume(resumeRun.id, "Continue once.")
          .pipe(Effect.flip);
        expect(resumeFailure).toMatchObject({ code: "resume_outcome_uncertain" });
        const uncertain = yield* service.status(resumeRun.id);
        expect(uncertain.state).toBe("starting");
        expect(uncertain.warning).toContain("may already have applied");
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("rolls back a definitely unsent reply and keeps the question answerable", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "unsent-reply" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "unsent-question",
        kind: "question",
        message: "Proceed with the retry plan?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");

      fake.controls[0]?.failNextIpc("transport_not_sent");
      expect(yield* service.reply(run.id, "Proceed.").pipe(Effect.flip)).toMatchObject({
        code: "reply_send_failed",
      });
      // A pre-send failure proves non-delivery: the question rolls back for an immediate retry.
      const status = yield* service.status(run.id);
      expect(status.state).toBe("waiting_for_parent");
      expect(status.question).toMatchObject({ requestId: "unsent-question" });
      expect(status.warning).toBeUndefined();

      expect((yield* service.reply(run.id, "Proceed.")).state).toBe("running");
      expect(fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply")).toEqual([
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "unsent-question",
          message: "Proceed.",
        },
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "unsent-question",
          message: "Proceed.",
        },
      ]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("clears an uncertain reply claim after terminal settlement and a resumed turn", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "reply-resolution" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "uncertain-terminal-question",
        kind: "question",
        message: "Finish this turn?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      fake.controls[0]?.failNextIpc("transport_outcome_uncertain");
      expect(yield* service.reply(run.id, "Finish.").pipe(Effect.flip)).toMatchObject({
        code: "reply_outcome_uncertain",
      });
      fake.controls[0]?.offer({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Turn resolved." }] },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      expect((yield* service.resume(run.id, "Next turn.")).state).toBe("running");
      fake.controls[1]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "resumed-question",
        kind: "question",
        message: "Question in resumed turn?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      expect((yield* service.reply(run.id, "Answered.")).state).toBe("running");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps warnings in projection and session history without host notification", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "bounded-notices" }));
      for (const [kind, message] of [
        ["progress", "First progress"],
        ["progress", "Second progress"],
        ["warning", "First warning"],
        ["warning", "Second warning"],
      ] as const)
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: `${kind}-${message}`,
          kind,
          message,
        });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning === "Second warning");
      expect(notifications).toEqual([]);

      fake.controls[0]?.offer({
        type: "extension_error",
        error: "Extension bridge failed token=secret-value",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("Extension bridge failed")),
      );
      expect(notifications).toEqual([]);
      const status = yield* service.status(run.id);
      expect(status.progress).toBe("Second progress");
      expect(status.warning).toContain("Extension bridge failed");
      expect(status.warning).not.toContain("secret-value");
      expect(
        status.sessionEvents.filter((event) => event.type === "notice" && event.kind === "warning"),
      ).toHaveLength(3);

      fake.controls[0]?.offer({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Final report." }] },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications).toMatchObject([
        {
          type: "completed",
          runs: [
            {
              id: run.id,
              outcome: "completed",
              finalText: "Final report.",
              warning: expect.stringContaining("Extension bridge failed"),
            },
          ],
        },
      ]);
      const completion = notifications[0];
      expect(completion?.type).toBe("completed");
      if (completion?.type === "completed") {
        expect(completion.runs[0]?.warning).toContain("System warning: Extension bridge failed");
        expect(completion.runs[0]?.warning).toContain("Child warning: Second warning");
        expect(completion.runs[0]?.warning).not.toContain("First warning");
        expect(completion.runs[0]?.warning).not.toContain("secret-value");
      }
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("folds child and system warnings into a failed outcome", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "warning-failure" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "child-risk",
        kind: "warning",
        message: "Child validation is incomplete.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Child validation is incomplete.",
      );
      fake.controls[0]?.offer({
        type: "extension_error",
        error: "Extension transport degraded.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Extension transport degraded.",
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications).toMatchObject([
        {
          type: "completed",
          runs: [
            {
              id: run.id,
              outcome: "failed",
              warning: expect.stringContaining("System warning: Extension transport degraded."),
            },
          ],
        },
      ]);
      const notification = notifications[0];
      expect(notification?.type).toBe("completed");
      if (notification?.type === "completed")
        expect(notification.runs[0]?.warning).toContain(
          "Child warning: Child validation is incomplete.",
        );
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("retries actionable question delivery once without warning interference", () => {
    const fake = fakeChildLayer();
    let attempts = 0;
    const delivered: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
      notify: (notification) => {
        if (notification.type === "completed") return undefined;
        attempts += 1;
        if (attempts === 1) throw new Error("transient parent delivery failure");
        delivered.push(notification);
        return {
          deliveredActionKeys: [`${notification.id}:question:default:${notification.generation}`],
        };
      },
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "retry-actions" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "retry-question",
        kind: "question",
        message: "Retry this question?",
      });
      yield* yieldUntil(() => attempts === 1);

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "projection-warning",
        kind: "warning",
        message: "Keep this warning in status only.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Keep this warning in status only.",
      );
      expect(attempts).toBe(1);

      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => delivered.length === 1);
      yield* TestClock.adjust("30 seconds");
      expect(attempts).toBe(2);
      expect(delivered).toMatchObject([{ type: "question", message: "Retry this question?" }]);
      expect((yield* service.status(run.id)).state).toBe("waiting_for_parent");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("restarts question delivery after a stale queue drains to idle", () => {
    const fake = fakeChildLayer();
    const attempts: Array<Extract<SubagentNotification, { type: "question" }>> = [];
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type === "completed") return undefined;
        attempts.push(notification);
        return notification.requestId === "stale-question"
          ? { deliveredActionKeys: [] }
          : {
              deliveredActionKeys: [
                `${notification.id}:question:default:${notification.generation}`,
              ],
            };
      },
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "action-idle-restart" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "stale-question",
        kind: "question",
        message: "This will become stale.",
      });
      yield* yieldUntil(() => attempts.some((value) => value.requestId === "stale-question"));
      yield* service.reply(run.id, "Resolved before retry.");
      yield* TestClock.adjust("200 millis");

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "new-question",
        kind: "question",
        message: "Delivery after idle?",
      });
      yield* yieldUntil(() => attempts.some((value) => value.requestId === "new-question"));
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("wakes a sleeping question retry when a new question is queued", () => {
    const fake = fakeChildLayer();
    const attempts: Array<Extract<SubagentNotification, { type: "question" }>> = [];
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type === "completed") return undefined;
        attempts.push(notification);
        return notification.requestId === "sleepy-question"
          ? { deliveredActionKeys: [] }
          : {
              deliveredActionKeys: [
                `${notification.id}:question:default:${notification.generation}`,
              ],
            };
      },
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "action-retry-wake" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "sleepy-question",
        kind: "question",
        message: "This attempt stays unacknowledged.",
      });
      yield* yieldUntil(() => attempts.some((value) => value.requestId === "sleepy-question"));
      yield* service.reply(run.id, "Answered while the retry slept.");

      // Queuing the replacement question wakes the sleeping retry loop without any
      // clock advancement past the pending backoff delay.
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "wake-question",
        kind: "question",
        message: "Deliver immediately after the wake?",
      });
      yield* yieldUntil(() => attempts.some((value) => value.requestId === "wake-question"));
      expect(attempts.filter((value) => value.requestId === "sleepy-question")).toHaveLength(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps currentTool accurate while parallel tools finish", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "parallel-tools" }));
      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-a",
        toolName: "read",
        args: {},
      });
      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-b",
        toolName: "grep",
        args: {},
      });
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-a",
        toolName: "read",
        result: {},
        isError: false,
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.currentTool === "grep");
      expect((yield* service.status(run.id)).currentTool).toBe("grep");
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-b",
        toolName: "grep",
        result: {},
        isError: false,
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.currentTool === undefined);
      expect((yield* service.status(run.id)).currentTool).toBeUndefined();
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("times out when an RPC transport write never completes", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "blocked-write" }));
      const sendGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", sendGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        operation: "await RPC response from",
      });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("fails pending RPCs immediately after a schema-invalid event", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "invalid-event-rpc" }));
      fake.controls[0]?.dropNext("set_session_name");
      const renaming = yield* service.rename(run.id, "renamed").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () =>
          fake.controls[0]?.commands.some((command) => command.type === "set_session_name") ??
          false,
      );
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      const failure = yield* Fiber.join(renaming).pipe(Effect.flip);
      expect(failure._tag).toBe("SubagentProtocolError");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect((yield* service.status(run.id)).name).toBe("invalid-event-rpc");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("rejects oversized parent messages before transport", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "bounded-message" }));
      const failure = yield* Effect.flip(service.send(run.id, "x".repeat(64 * 1024 + 1)));
      expect(failure._tag).toBe("InvalidSubagentRequestError");
      expect(fake.controls[0]?.commands.filter((command) => command.type === "steer")).toEqual([]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
