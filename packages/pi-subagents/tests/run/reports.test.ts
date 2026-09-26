// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { MAX_COMPLETION_DELIVERY_BATCH } from "../../src/run/limits.ts";
import { emptyUsage } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  acknowledgeCompletions,
  fakeRetainedBackendLayer,
  assistantMessageEndFrame,
  fakeChildLayer,
  request,
  localServiceFixture,
  retainedRequest,
  retainedServiceFixture,
  retainedReportFrame,
  withService,
} from "./fixtures/service-harness.ts";

const awaitAndConsume = (service: SubagentServiceContract, ids: ReadonlyArray<string>) =>
  service.withAwaitTerminalObservations(ids, "all_finished", undefined, (observations) =>
    service
      .consumeCompletions(
        observations.flatMap((observation) =>
          observation.completionReceipt ? [observation.completionReceipt] : [],
        ),
      )
      .pipe(Effect.as(observations)),
  );

const resumableBackend = () =>
  fakeRetainedBackendLayer({ capabilities: ["steer", "interrupt", "resume", "rename-display"] });

/** Pauses a close-on-report run, then forks a gated resume whose start fails as uncertain. */
const pausedUncertainResume = (
  service: SubagentServiceContract,
  backend: ReturnType<typeof fakeRetainedBackendLayer>,
  message: string,
) =>
  Effect.gen(function* () {
    const run = yield* service.start(retainedRequest({ closeOnReport: true }));
    expect((yield* service.interrupt(run.id)).state).toBe("paused");
    const resumeGate = yield* Deferred.make<void>();
    backend.controls[0]?.gateNextStart(resumeGate);
    backend.controls[0]?.failNextStart("transport_outcome_uncertain");
    const resuming = yield* service.resume(run.id, message).pipe(Effect.forkScoped);
    yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 2);
    return { run, resumeGate, resuming };
  });

describe("local Pi terminal evidence", () => {
  for (const stopReason of ["error", "aborted", "length", "toolUse", "stop", undefined] as const) {
    it.effect(
      `fails a settled ${stopReason ?? "missing"} attempt without accepting partial output`,
      () => {
        const { fake, projections, layer } = localServiceFixture();
        return withService(layer, function* (service) {
          const run = yield* service.start(request());
          fake.controls[0]!.offer(assistantMessageEndFrame("Earlier success must not leak."));
          fake.controls[0]!.offer({ type: "message_start", message: { role: "assistant" } });
          if (stopReason !== undefined)
            fake.controls[0]!.offer({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason,
                errorMessage: "Provider unavailable.\u001b[31m",
                content: [{ type: "text", text: stopReason === "stop" ? "   " : "Partial work." }],
              },
            });
          fake.controls[0]!.offer({ type: "agent_settled" });
          yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
          const result = yield* service.status(run.id);
          expect(result).toMatchObject({
            state: "failed",
            reportGeneration: 0,
            reportStatus: "missing",
          });
          expect(result.finalText).toBeUndefined();
          expect(result.error).toContain("writes may already exist");
          expect(result.error).not.toContain("\u001b");
          if (stopReason === "error") expect(result.error).toContain("Provider unavailable.");
          fake.controls[0]!.exit(0);
          yield* yieldUntil(() => fake.controls[0]!.released() === 1);
        });
      },
    );
  }

  it.effect("lets automatic retries recover before final settlement", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      fake.controls[0]!.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Transient failure",
          content: [],
          usage: { input: 1, totalTokens: 1 },
        },
      });
      fake.controls[0]!.offer({ type: "turn_end" });
      fake.controls[0]!.offer({ type: "agent_end", willRetry: true });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 1);
      expect((yield* service.status(run.id)).state).toBe("running");
      fake.controls[0]!.offer({ type: "agent_start" });
      fake.controls[0]!.settle("Recovered report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect(yield* service.status(run.id)).toMatchObject({
        state: "completed",
        reportGeneration: 1,
        finalText: "Recovered report.",
        reportStatus: "available",
      });
    });
  });

  it.effect(
    "does not reuse the previous assistant attempt after a paused assignment resumes",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request());
        fake.controls[0]!.offer({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Previous attempt." }],
            usage: { input: 1, totalTokens: 1 },
          },
        });
        fake.controls[0]!.offer({ type: "turn_end" });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 1);
        expect((yield* service.interrupt(run.id)).state).toBe("paused");
        yield* service.resume(run.id, "Continue");
        fake.controls[0]!.offer({ type: "agent_settled" });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        expect(yield* service.status(run.id)).toMatchObject({
          reportGeneration: 0,
          reportStatus: "missing",
        });
      });
    },
  );

  for (const stopReason of ["error", "stop"] as const) {
    it.effect(
      `preserves buffered ${stopReason} settlement while prompt admission is in flight`,
      () => {
        const gate = Deferred.makeUnsafe<void>();
        const { fake, projections, layer } = localServiceFixture(
          {},
          fakeChildLayer(Effect.void, {
            initialSendGates: [{ spawnIndex: 0, type: "prompt", gate }],
          }),
        );
        return withService(layer, function* (service) {
          const starting = yield* service.start(request()).pipe(Effect.forkScoped);
          yield* yieldUntil(() => fake.controls[0]?.sent("prompt") === true);
          fake.controls[0]!.offer({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason,
              content: [{ type: "text", text: "Buffered report." }],
              usage: { input: 1, totalTokens: 1 },
            },
          });
          fake.controls[0]!.offer({ type: "agent_settled" });
          yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 1);
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(starting).pipe(Effect.exit);
          yield* yieldUntil(
            () =>
              projections.at(-1)?.runs[0]?.state ===
              (stopReason === "stop" ? "completed" : "failed"),
          );
          expect(projections.at(-1)?.runs[0]?.reportGeneration).toBe(stopReason === "stop" ? 1 : 0);
        });
      },
    );
  }
});

describe("SubagentService", () => {
  it.effect(
    "keeps a report arriving during start admission queued for exact-once await delivery",
    () => {
      const report = "Report completed while prompt admission was in flight.";
      const initialStartGate = Deferred.makeUnsafe<void>();
      const { backend, projections, notifications, layer } = retainedServiceFixture(
        fakeRetainedBackendLayer({ initialStartGate }),
      );
      return withService(layer, function* (service) {
        const starting = yield* service
          .startSessionOwned(
            retainedRequest({
              name: "fast-report",
            }),
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        backend.controls[0]?.offer({
          type: "assistant_message",
          assignmentEpoch: 1,
          text: report,
          usage: { ...emptyUsage(), cost: 0 },
        });
        backend.controls[0]?.offer(retainedReportFrame(id!, 1, 1, "report-during-start", report));
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs[0]?.sessionEvents.some(
                (event) => event.type === "assistant" && event.text === report,
              ),
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(initialStartGate, undefined);

        const started = yield* Fiber.join(starting);
        expect(started.state).toBe("reported");
        expect(started).not.toHaveProperty("finalText");
        expect(started.sessionEvents).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ text: report })]),
        );

        const delivered = yield* awaitAndConsume(service, [started.id]);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.run.finalText).toBe(report);
        expect(delivered[0]?.run.sessionEvents).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "assistant", text: report })]),
        );

        yield* TestClock.adjust("1 second");
        expect(notifications).toEqual([]);
        expect(yield* service.status(started.id)).not.toHaveProperty("finalText");
      });
    },
  );

  it.effect(
    "replays a buffered close-on-report report when run_started precedes uncertain resume failure",
    () => {
      const report = "Completed before resume transport failure surfaced.";
      const { backend, projections, layer } = retainedServiceFixture(resumableBackend());
      return withService(layer, function* (service) {
        const { run, resumeGate, resuming } = yield* pausedUncertainResume(
          service,
          backend,
          "Resume through an uncertain transport.",
        );
        backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
        backend.controls[0]?.offer(
          retainedReportFrame(run.id, 2, 1, "started-before-failure", report),
        );
        backend.controls[0]?.offer({
          type: "assistant_message",
          assignmentEpoch: 2,
          text: "Buffered report barrier.",
          usage: { ...emptyUsage(), cost: 0 },
        });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs[0]?.sessionEvents.some(
                (event) => event.type === "assistant" && event.text === "Buffered report barrier.",
              ),
          ),
        );
        yield* Deferred.succeed(resumeGate, undefined);

        expect(yield* Fiber.join(resuming).pipe(Effect.flip)).toMatchObject({
          code: "resume_outcome_uncertain",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "completed",
          reportGeneration: 1,
          finalText: report,
          warning: expect.stringContaining("may already have applied"),
        });

        const delivered = yield* awaitAndConsume(service, [run.id]);
        expect(delivered[0]).toMatchObject({
          run: { finalText: report, warning: expect.stringContaining("may already have applied") },
          completionReceipt: { id: run.id, generation: 1 },
        });

        backend.controls[0]?.offer(
          retainedReportFrame(run.id, 2, 1, "started-before-failure", report),
        );
        yield* Effect.yieldNow;
        const afterDuplicate = yield* service.withStatusObservations([run.id], ({ observations }) =>
          Effect.succeed(observations[0]),
        );
        expect(afterDuplicate?.completionReceipt).toBeUndefined();
        expect(afterDuplicate?.run.reportGeneration).toBe(1);
      });
    },
  );

  it.effect(
    "gives a buffered close-on-report report precedence after uncertain resume failure",
    () => {
      const report = "Buffered report won over settlement.";
      const { backend, projections, layer } = retainedServiceFixture(resumableBackend());
      return withService(layer, function* (service) {
        const { run, resumeGate, resuming } = yield* pausedUncertainResume(
          service,
          backend,
          "Resume before start evidence arrives.",
        );
        yield* Deferred.succeed(resumeGate, undefined);
        expect(yield* Fiber.join(resuming).pipe(Effect.flip)).toMatchObject({
          code: "resume_outcome_uncertain",
        });
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "starting",
          warning: expect.stringContaining("may already have applied"),
        });

        const bufferedReport = {
          type: "report" as const,
          assignmentEpoch: 2,
          runId: run.id,
          sequence: 1,
          deliveryId: "failure-before-started",
          text: report,
        };
        backend.controls[0]?.offer(bufferedReport);
        backend.controls[0]?.offer(bufferedReport);
        backend.controls[0]?.offer({ type: "run_settled", assignmentEpoch: 2 });
        backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          reportGeneration: 1,
          finalText: report,
          warning: expect.stringContaining("may already have applied"),
        });

        const delivered = yield* service.withAwaitTerminalObservations(
          [run.id],
          "all_finished",
          undefined,
          (observations) => Effect.succeed(observations),
        );
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({
          run: { finalText: report, reportGeneration: 1 },
          completionReceipt: { id: run.id, generation: 1 },
        });
      });
    },
  );

  it.effect("starts retained follow-ups without advertising unconfirmable active steering", () => {
    const { backend, projections, layer } = retainedServiceFixture(
      fakeRetainedBackendLayer({ capabilities: ["rename-display"] }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      const activeGuidanceFailure = yield* service
        .send(run.id, "Unconfirmed active guidance")
        .pipe(Effect.flip);
      expect(activeGuidanceFailure).toMatchObject({
        _tag: "UnsupportedSubagentCapabilityError",
        capability: "steer",
      });

      backend.controls[0]?.report(run.id, 1, "retained-without-steer", "First retained report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      const followUp = yield* service.send(run.id, "Begin a new retained assignment.");
      expect(followUp).toMatchObject({ state: "running", reportGeneration: 1 });
      expect(backend.controls[0]?.prompts.at(-1)).toBe("Begin a new retained assignment.");
    });
  });

  it.effect("keeps a retained assignment owner alive after its send waiter is cancelled", () => {
    const { backend, projections, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(run.id, 1, "cancelled-send-owner", "First assignment complete.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      const startGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(startGate);
      const sending = yield* service
        .send(run.id, "Continue after the caller leaves.")
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () =>
          backend.controls[0]?.assignmentEpochs.filter((epoch) => epoch === 2).length === 1 &&
          projections.at(-1)?.runs[0]?.state === "starting",
      );

      yield* Fiber.interrupt(sending);
      yield* Deferred.succeed(startGate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");

      expect(backend.controls[0]?.assignmentEpochs).toEqual([1, 2]);
      expect(backend.controls[0]?.prompts.at(-1)).toBe("Continue after the caller leaves.");
      expect(yield* service.status(run.id)).toMatchObject({
        state: "running",
        reportGeneration: 1,
      });
    });
  });

  it.effect(
    "claims retained reports, deduplicates delivery, begins the next assignment, and notifies a cancelled await exactly once",
    () => {
      const { backend, projections, notifications, layer } = retainedServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(retainedRequest());
        expect(run).toMatchObject({ state: "running", reportGeneration: 0, pid: 22_001 });
        expect(backend.controls[0]?.prompts).toHaveLength(1);

        const firstAwait = yield* awaitAndConsume(service, [run.id]).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        backend.controls[0]?.report(run.id, 1, "report-one", "First retained report.", {
          evidence: "fixture-owned-pane",
        });
        const first = yield* Fiber.join(firstAwait);
        expect(first[0]).toMatchObject({
          run: {
            state: "reported",
            reportGeneration: 1,
            finalText: "First retained report.",
            pid: 22_001,
          },
          completionReceipt: {
            id: run.id,
            generation: 1,
            claimToken: expect.any(String),
          },
        });
        backend.controls[0]?.report(run.id, 1, "report-one", "Duplicate must be ignored.");
        yield* Effect.yieldNow;
        const redactedStatus = yield* service.status(run.id);
        expect(redactedStatus).toMatchObject({
          state: "reported",
          reportGeneration: 1,
          pid: 22_001,
        });
        expect(redactedStatus).not.toHaveProperty("finalText");
        expect(projections.at(-1)?.runs[0]?.finalText).toBe("First retained report.");
        expect(backend.controls[0]?.released()).toBe(0);

        const guided = yield* service.send(run.id, "Investigate the follow-up.");
        expect(guided).toMatchObject({ state: "running", reportGeneration: 1 });
        expect(guided.finalText).toBeUndefined();
        expect(backend.controls[0]?.prompts.at(-1)).toBe("Investigate the follow-up.");

        const cancelledAwait = yield* service
          .awaitTerminal([run.id], "all_finished")
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(cancelledAwait);
        backend.controls[0]?.report(run.id, 2, "report-two", "Second retained report.");
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "reported",
        );
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(
          () =>
            notifications.filter((notification) => notification.type === "completed").length === 1,
        );
        expect(notifications).toMatchObject([
          {
            type: "completed",
            runs: [
              {
                id: run.id,
                generation: 2,
                finalText: "Second retained report.",
                retained: true,
              },
            ],
          },
        ]);
        yield* TestClock.adjust("1 second");
        expect(
          notifications.filter((notification) => notification.type === "completed"),
        ).toHaveLength(1);

        const stopped = yield* service.stop(run.id);
        expect(stopped.state).toBe("stopped");
        expect(backend.controls[0]?.released()).toBe(1);
      });
    },
  );

  it.effect("delivers a retained report and later failure as distinct outcome generations", () => {
    const { backend, projections, notifications, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(
        retainedRequest({
          name: "retained-failure-generation",
        }),
      );
      backend.controls[0]?.report(run.id, 1, "retained-success", "First report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id, generation: 1, outcome: "completed", retained: true }],
      });

      expect((yield* service.send(run.id, "Begin the next assignment.")).state).toBe("running");
      backend.controls[0]?.offer({
        type: "exit",
        exitCode: 1,
        diagnostic: "Retained backend exited.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 2);
      expect(notifications[1]).toMatchObject({
        type: "completed",
        runs: [
          {
            id: run.id,
            generation: 2,
            outcome: "failed",
            error: "Retained backend exited.",
          },
        ],
      });
    });
  });

  it.effect("ignores a retained report after terminal failure before process exit", () => {
    const { backend, projections, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      const control = backend.controls[0]!;
      control.offer({ type: "protocol_error", message: "Process failed before report." });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      control.offer(retainedReportFrame(run.id, 1, 1, "late", "Must not resurrect the run."));
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      expect(yield* service.status(run.id)).toMatchObject({ state: "failed", reportGeneration: 0 });
    });
  });

  for (const terminal of ["stopped", "failed"] as const)
    for (const outcome of ["success", "definite", "uncertain"] as const)
      for (const startedObserved of [false, true])
        for (const bufferedReport of [false, true])
          it.effect(
            `keeps ${terminal} after late ${outcome} assignment confirmation, started=${startedObserved}, report=${bufferedReport}`,
            () => {
              const { backend, projections, layer } = retainedServiceFixture();
              return withService(layer, function* (service) {
                const run = yield* service.start(retainedRequest());
                const control = backend.controls[0]!;
                control.offer(retainedReportFrame(run.id, 1, 1, "first", "First report."));
                yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
                const gate = yield* Deferred.make<void>();
                control.gateNextStart(gate);
                if (outcome !== "success")
                  control.failNextStart(
                    outcome === "uncertain" ? "transport_outcome_uncertain" : undefined,
                  );
                const sending = yield* service
                  .send(run.id, "Second assignment.")
                  .pipe(Effect.exit, Effect.forkScoped);
                yield* yieldUntil(() => control.assignmentEpochs.at(-1) === 2);
                if (startedObserved) {
                  control.offer({ type: "run_started", assignmentEpoch: 2 });
                  yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
                }
                if (bufferedReport)
                  control.offer(
                    retainedReportFrame(
                      run.id,
                      2,
                      2,
                      "buffered",
                      "Must not replace terminal state.",
                    ),
                  );
                yield* Effect.yieldNow;
                if (terminal === "stopped") yield* service.stop(run.id);
                else {
                  control.offer({ type: "protocol_error", message: "Assignment failed." });
                  yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
                  // The fixture does not emit process exit on terminate. Join cleanup explicitly.
                  yield* service.stop(run.id);
                }
                yield* yieldUntil(() => control.released() === 1);
                const before = yield* service.status(run.id);
                yield* Deferred.succeed(gate, undefined);
                yield* Fiber.join(sending);
                const after = yield* service.status(run.id);
                expect(after).toMatchObject({
                  state: terminal,
                  reportGeneration: 1,
                  endedAt: before.endedAt,
                });
                expect(after.error).toBe(before.error);
                expect(after.finalText).toBe(before.finalText);
                expect(after.warning).toBe(before.warning);
                expect(control.released()).toBe(1);
              });
            },
          );

  it.effect("settles a retained issuing assignment when the backend fails its protocol", () => {
    const { backend, projections, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(
        run.id,
        1,
        "before-terminal-reconcile",
        "First assignment complete.",
      );
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      const startGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(startGate);
      const sending = yield* service
        .send(run.id, "Start the assignment that will fail closed.")
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () =>
          backend.controls[0]?.assignmentEpochs.at(-1) === 2 &&
          projections.at(-1)?.runs[0]?.state === "starting",
      );
      backend.controls[0]?.offer({
        type: "protocol_error",
        message: "Herdr prompt evidence expired.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(projections.at(-1)?.runs[0]).toMatchObject({ state: "failed", reportGeneration: 1 });

      yield* Deferred.succeed(startGate, undefined);
      expect(yield* Fiber.join(sending).pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "guidance_outcome_uncertain",
      });
      expect((yield* service.status(run.id)).state).toBe("failed");
    });
  });

  it.effect("commits an initial report only after the matching start command confirms", () => {
    const initialStartGate = Deferred.makeUnsafe<void>();
    const { backend, projections, layer } = retainedServiceFixture(
      fakeRetainedBackendLayer({ initialStartGate }),
    );
    return withService(layer, function* (service) {
      const starting = yield* service.start(retainedRequest()).pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      backend.controls[0]?.offer(
        retainedReportFrame(id!, 1, 1, "initial-in-flight", "Fast initial report."),
      );
      yield* Effect.yieldNow;
      expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
      yield* Deferred.succeed(initialStartGate, undefined);
      expect(yield* Fiber.join(starting)).toMatchObject({
        state: "reported",
        reportGeneration: 1,
        finalText: "Fast initial report.",
      });
    });
  });

  it.effect(
    "buffers an in-flight retained report and does not poison its later valid retry",
    () => {
      const { backend, projections, layer } = retainedServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(retainedRequest());
        backend.controls[0]?.report(run.id, 1, "first-delivery", "First assignment.");
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
        expect((yield* service.status(run.id)).finalText).toBe("First assignment.");

        backend.controls[0]?.offer(
          retainedReportFrame(run.id, 1, 2, "second-delivery", "Too early."),
        );
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("protocol-invalid")),
        );
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "reported",
          reportGeneration: 1,
          finalText: "First assignment.",
        });
        expect(
          (yield* service.status(run.id)).sessionEvents.some(
            (event) =>
              event.type === "notice" &&
              event.kind === "warning" &&
              event.text.includes("protocol-invalid"),
          ),
        ).toBe(true);

        backend.controls[0]?.offer(
          retainedReportFrame(
            run.id,
            1,
            1,
            "first-delivery",
            "Exact retry with changed text is ignored.",
          ),
        );
        const startGate = yield* Deferred.make<void>();
        backend.controls[0]?.gateNextStart(startGate);
        const sending = yield* service
          .send(run.id, "Begin the second assignment.")
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.prompts.length === 2);
        backend.controls[0]?.offer(
          retainedReportFrame(
            run.id,
            2,
            2,
            "second-delivery",
            "Second assignment committed after start.",
          ),
        );
        yield* Effect.yieldNow;
        expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
        yield* Deferred.succeed(startGate, undefined);
        expect(yield* Fiber.join(sending)).toMatchObject({
          state: "reported",
          reportGeneration: 2,
          finalText: "Second assignment committed after start.",
        });
      });
    },
  );

  it.effect("rejects a reused report sequence with a conflicting delivery identity", () => {
    const { backend, projections, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(run.id, 1, "first-delivery", "First assignment.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      yield* service.send(run.id, "Begin the second assignment.");
      backend.controls[0]?.offer(
        retainedReportFrame(
          run.id,
          2,
          1,
          "conflicting-delivery",
          "Conflicting delivery-identity reuse.",
        ),
      );
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("reused delivery identity")),
      );
      expect(projections.at(-1)?.runs[0]).toMatchObject({
        state: "running",
        reportGeneration: 1,
      });

      backend.controls[0]?.offer(
        retainedReportFrame(run.id, 2, 2, "second-delivery", "Second assignment."),
      );
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === 2);
      expect((yield* service.status(run.id)).finalText).toBe("Second assignment.");
    });
  });

  it.effect(
    "rejects a second differing in-flight report while the start command is issuing",
    () => {
      const initialStartGate = Deferred.makeUnsafe<void>();
      const { backend, projections, layer } = retainedServiceFixture(
        fakeRetainedBackendLayer({ initialStartGate }),
      );
      return withService(layer, function* (service) {
        const starting = yield* service.start(retainedRequest()).pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        backend.controls[0]?.offer(
          retainedReportFrame(id!, 1, 1, "buffered-in-flight", "Buffered in-flight report."),
        );
        backend.controls[0]?.offer(
          retainedReportFrame(id!, 1, 2, "second-in-flight", "Second in-flight report."),
        );
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("more than one in-flight report")),
        );
        expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
        yield* Deferred.succeed(initialStartGate, undefined);
        expect(yield* Fiber.join(starting)).toMatchObject({
          state: "reported",
          reportGeneration: 1,
          finalText: "Buffered in-flight report.",
        });
      });
    },
  );

  it.effect("rejects retained reports outside Herdr read-only backends before admission", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failure = yield* service.start(request({ closeOnReport: false })).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "retained_report_capability_invalid",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    });
  });

  it.effect("reserves generation 64 for terminal failure after 63 retained reports", () => {
    const { backend, projections, layer } = retainedServiceFixture(fakeRetainedBackendLayer(), {
      notify: (notification) =>
        notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined,
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      for (let generation = 1; generation <= 63; generation += 1) {
        backend.controls[0]?.report(
          run.id,
          generation,
          `backlog-${generation}`,
          `Backlog report ${generation}.`,
        );
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === generation);
        if (generation < 63) yield* service.send(run.id, `Begin assignment ${generation + 1}.`);
      }
      const failure = yield* service.send(run.id, "Exceed the backlog.").pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "report_delivery_backlog",
      });

      backend.controls[0]?.offer({
        type: "exit",
        exitCode: 1,
        diagnostic: "Retained backend failed after its final admitted report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      const terminalGeneration = yield* service.withStatusObservations(
        [run.id],
        ({ observations }) => {
          const receipt = observations[0]?.completionReceipt;
          return receipt
            ? service.consumeCompletions([receipt]).pipe(Effect.as(receipt.generation))
            : Effect.void;
        },
      );
      expect(terminalGeneration).toBe(64);

      backend.controls[0]?.offer({
        type: "exit",
        exitCode: 1,
        diagnostic: "Duplicate terminal evidence.",
      });
      yield* Effect.yieldNow;
      const afterDuplicate = yield* service.withStatusObservations([run.id], ({ observations }) =>
        Effect.succeed(observations[0]),
      );
      expect(afterDuplicate?.completionReceipt).toBeUndefined();
      expect(afterDuplicate?.run.reportGeneration).toBe(63);
    });
  });

  it.effect("caps resumed runs at 64 unresolved report generations", () => {
    const { fake, projections, layer } = localServiceFixture({
      notify: (notification) =>
        notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined,
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "resume-backlog" }));
      for (let generation = 1; generation <= 64; generation += 1) {
        fake.controls[generation - 1]?.settle();
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs[0]?.state === "completed" &&
            projections.at(-1)?.runs[0]?.reportGeneration === generation,
        );
        if (generation < 64)
          yield* service.resume(run.id, `Continue assignment ${generation + 1}.`);
      }

      const failure = yield* service.resume(run.id, "Exceed the backlog.").pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "report_delivery_backlog",
      });
      expect(fake.controls).toHaveLength(64);
    });
  });

  it.effect("rolls back a raced retained start and never reuses its assignment epoch", () => {
    const { backend, projections, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(run.id, 1, "rollback-report", "Preserve this report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Original system warning",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning === "Original system warning");
      const previousWarning = projections.at(-1)!.runs[0]!;
      const failureGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(failureGate);
      backend.controls[0]?.failNextStart();
      const failing = yield* service
        .send(run.id, "Definite failing assignment.")
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 2);
      backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 2,
        requestId: "failed-child-warning",
        kind: "warning",
        message: "Warning from the failed assignment.",
      });
      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Handle warning during failed assignment.",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("Handle warning")),
      );
      yield* Deferred.succeed(failureGate, undefined);
      expect(yield* Fiber.join(failing).pipe(Effect.flip)).toMatchObject({
        _tag: "SubagentProcessError",
      });
      const rolledBack = yield* service.status(run.id);
      expect(rolledBack).toMatchObject({
        state: "reported",
        reportGeneration: 1,
        finalText: "Preserve this report.",
      });
      expect(rolledBack.warning).toBe(previousWarning.warning);
      expect(rolledBack.warningSource).toBe(previousWarning.warningSource);
      expect(rolledBack.systemWarning).toBe(previousWarning.systemWarning);
      expect(
        rolledBack.sessionEvents.filter(
          (event) => event.type === "notice" && event.kind === "warning",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Warning from the failed assignment." }),
          expect.objectContaining({
            text: "Extension error: Handle warning during failed assignment.",
          }),
        ]),
      );

      const nextGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(nextGate);
      const next = yield* service.send(run.id, "Next valid assignment.").pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 3);
      const reset = yield* service.status(run.id);
      expect(reset.warning).toBeUndefined();
      expect(reset.warningSource).toBeUndefined();
      expect(reset.systemWarning).toBeUndefined();
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 2,
        requestId: "old-progress",
        kind: "progress",
        message: "Stale progress must not apply.",
      });
      backend.controls[0]?.offer({
        type: "tool_started",
        assignmentEpoch: 2,
        toolCallId: "old-tool",
        toolName: "stale-tool",
        args: {},
      });
      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Lifecycle warning remains handle-scoped.",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("Lifecycle warning")),
      );
      expect(projections.at(-1)?.runs[0]?.progress).toBeUndefined();
      expect(projections.at(-1)?.runs[0]?.currentTool).toBeUndefined();
      yield* Deferred.succeed(nextGate, undefined);
      expect((yield* Fiber.join(next)).state).toBe("running");
      expect(backend.controls[0]?.assignmentEpochs).toEqual([1, 2, 3]);
    });
  });

  it.effect("keeps outcome-uncertain retained work and ignores idle assignment events", () => {
    const { backend, projections, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(run.id, 1, "idle-report", "Idle report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      const beforeIdle = projections.at(-1)?.runs[0];
      backend.controls[0]?.offer({ type: "activity", assignmentEpoch: 1 });
      backend.controls[0]?.offer({
        type: "assistant_message",
        assignmentEpoch: 1,
        text: "Late assistant text.",
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: 1 },
      });
      backend.controls[0]?.offer({
        type: "tool_started",
        assignmentEpoch: 1,
        toolCallId: "late-tool",
        toolName: "late",
        args: {},
      });
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "late-question",
        kind: "question",
        message: "Late question?",
      });
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "late-progress",
        kind: "progress",
        message: "Late progress.",
      });
      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Handle warning after report.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Handle warning after report.",
      );
      const afterIdle = projections.at(-1)?.runs[0];
      expect(afterIdle).toMatchObject({
        state: "reported",
        lastActivityAt: beforeIdle?.lastActivityAt,
        usage: beforeIdle?.usage,
        finalText: "Idle report.",
      });
      expect(afterIdle?.currentTool).toBeUndefined();
      expect(afterIdle?.progress).toBeUndefined();
      expect(afterIdle?.question).toBeUndefined();

      const uncertainGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(uncertainGate);
      backend.controls[0]?.failNextStart("transport_outcome_uncertain");
      const uncertain = yield* service
        .send(run.id, "Uncertain assignment.")
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 2);
      backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
      backend.controls[0]?.offer(
        retainedReportFrame(
          run.id,
          2,
          2,
          "uncertain-report",
          "Applied despite uncertain response.",
        ),
      );
      yield* Deferred.succeed(uncertainGate, undefined);
      expect(yield* Fiber.join(uncertain).pipe(Effect.flip)).toMatchObject({
        _tag: "SubagentProcessError",
        code: "resume_outcome_uncertain",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === 2);
      expect(projections.at(-1)?.runs[0]).toMatchObject({
        state: "reported",
        finalText: "Applied despite uncertain response.",
        warning: expect.stringContaining("may already have applied"),
      });
    });
  });

  it.effect("drains completion generations in deterministic batches of twelve", () => {
    const batches: number[][] = [];
    const { backend, projections, layer } = retainedServiceFixture(fakeRetainedBackendLayer(), {
      notify: (notification) => {
        if (notification.type === "completed")
          batches.push(notification.runs.map((run) => run.generation));
        return acknowledgeCompletions(notification);
      },
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      const generationCount = MAX_COMPLETION_DELIVERY_BATCH + 1;
      for (let generation = 1; generation <= generationCount; generation += 1) {
        backend.controls[0]?.report(
          run.id,
          generation,
          `batch-${generation}`,
          `Report ${generation}.`,
        );
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === generation);
        if (generation < generationCount)
          yield* service.send(run.id, `Begin assignment ${generation + 1}.`);
      }

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 1);
      expect(batches[0]).toEqual(
        Array.from({ length: MAX_COMPLETION_DELIVERY_BATCH }, (_, index) => index + 1),
      );
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 2);
      expect(batches[1]).toEqual([generationCount]);
    });
  });

  it.effect("consumes a stopped retained report claim without a later notification", () => {
    const { backend, projections, notifications, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(run.id, 1, "stopped-claim", "Retained before stop.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      expect((yield* service.stop(run.id)).state).toBe("stopped");

      const claimed = yield* service.status(run.id);
      expect(claimed).toMatchObject({ state: "stopped", finalText: "Retained before stop." });
      expect(yield* service.status(run.id)).not.toHaveProperty("finalText");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect("keeps an atomically committed retained report deliverable after stop", () => {
    const { backend, projections, notifications, layer } = retainedServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      backend.controls[0]?.report(
        run.id,
        1,
        "committed-before-stop",
        "Committed before event-fiber cleanup.",
      );
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      expect((yield* service.stop(run.id)).state).toBe("stopped");
      expect(backend.controls[0]?.released()).toBe(1);

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [
          {
            id: run.id,
            generation: 1,
            retained: true,
            finalText: "Committed before event-fiber cleanup.",
          },
        ],
      });
    });
  });

  it.effect("lets an accepted retained report settle a pending pause atomically", () => {
    const interruptStarted = Deferred.makeUnsafe<void>();
    const interruptGate = Deferred.makeUnsafe<void>();
    const { backend, projections, notifications, layer } = retainedServiceFixture(
      fakeRetainedBackendLayer({
        interruptGate,
        onInterruptStarted: () => Deferred.doneUnsafe(interruptStarted, Effect.void),
        capabilities: ["steer", "interrupt", "rename-display"],
      }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(retainedRequest());
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* Deferred.await(interruptStarted);
      backend.controls[0]?.report(run.id, 1, "report-wins-pause", "Report won the pause race.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      expect(yield* Fiber.join(interrupting).pipe(Effect.flip)).toMatchObject({
        code: "interrupt_outcome_uncertain",
      });
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id, finalText: "Report won the pause race." }],
      });
    });
  });

  it.effect("closes an idle retained backend on session shutdown", () => {
    const { backend, layer } = retainedServiceFixture();
    return Effect.gen(function* () {
      const run = yield* withService(layer, function* (service) {
        const started = yield* service.start(retainedRequest());
        backend.controls[0]?.report(started.id, 1, "shutdown-report", "Idle now.");
        yield* yieldUntil(() =>
          Boolean(backend.controls[0] && backend.controls[0].released() === 0),
        );
        return started;
      });
      expect(run.id).toBeDefined();
      expect(backend.controls[0]?.released()).toBe(1);
    });
  });
});
