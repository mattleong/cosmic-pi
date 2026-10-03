// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { MAX_COMPLETION_DELIVERY_BATCH } from "../../src/run/limits.ts";
import { processError } from "../../src/run/errors.ts";
import { MAX_ERROR_CHARS } from "../../src/run/state.ts";
import { makeRunSettlement } from "../../src/run/settlement.ts";
import type { RunRecord } from "../../src/run/internal.ts";
import type { RunNotificationDelivery } from "../../src/run/notification-delivery.ts";
import { makeRunContext } from "./fixtures/run-context.ts";
import { view } from "../tools/fixtures/tool-harness.ts";
import { emptyUsage } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  acknowledgeCompletions,
  fakeNativeReportBackendLayer,
  assistantMessageEndFrame,
  fakeChildLayer,
  request,
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  nativeReportFrame,
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
  fakeNativeReportBackendLayer({
    capabilities: ["steer", "interrupt", "resume", "rename-display"],
  });

/** Pauses a close-on-report run, then forks a gated resume whose start fails as uncertain. */
const pausedUncertainResume = (
  service: SubagentServiceContract,
  backend: ReturnType<typeof fakeNativeReportBackendLayer>,
  message: string,
) =>
  Effect.gen(function* () {
    const run = yield* service.start(nativeReportRequest({ closeOnReport: true }));
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

describe("primary failure privacy", () => {
  const rawPrimary = () =>
    processError(
      "steer",
      "steer_outcome_uncertain",
      `Primary acknowledgement failure token=secret-credential \u001b[31m${"x".repeat(9000)}`,
    );
  const expectSanitized = (text: string | undefined) => {
    expect(text).toContain("Primary acknowledgement failure");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("secret-credential");
    expect(text).not.toContain("\u001b");
    expect(text?.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
  };

  it.effect(
    "retains typed initialization cause privately but only queues bounded redacted settlement",
    () =>
      Effect.gen(function* () {
        const fields = {
          view: view({ state: "starting" }),
          stoppedByParent: false,
          initializationPending: true,
        } satisfies Pick<RunRecord, "view" | "stoppedByParent" | "initializationPending">;
        // SAFETY: Deferred initialization failure uses only these fields and writes cleanup/failure/pending-settlement facts.
        const record = fields as RunRecord;
        // SAFETY: Deferred initialization settlement does not allocate or notify a completion.
        const delivery = {} as RunNotificationDelivery;
        const settlement = makeRunSettlement({
          ...(yield* makeRunContext()),
          delivery,
          closeRecordScope: () => Effect.void,
        });
        const primary = rawPrimary();
        yield* settlement.failRun(record, primary.message, primary);
        expect(record.backendFailure).toBe(primary);
        expectSanitized(record.pendingInitializationSettlement?.error);
      }),
  );

  for (const source of ["backend", "exit"] as const)
    it.effect(`redacts and bounds the primary ${source} error before public run projection`, () => {
      const { backend, projections, layer } = nativeReportServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(nativeReportRequest({ closeOnReport: true }));
        const primary = rawPrimary();
        backend.controls[0]!.offer(
          source === "backend"
            ? { type: "backend_failure", error: primary }
            : { type: "exit", exitCode: null, diagnostic: "generic exit", failure: primary },
        );
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        expectSanitized((yield* service.status(run.id)).error);
        for (const projection of projections) {
          const error = projection.runs[0]?.error;
          if (error) expectSanitized(error);
        }
      });
    });
});

describe("SubagentService", () => {
  it.effect(
    "accepted report keeps guidance-unconfirmed warning and ignores late delivery state",
    () => {
      const { backend, projections, layer } = nativeReportServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(nativeReportRequest({ closeOnReport: true }));
        const control = backend.controls[0]!;
        control.offer({
          type: "input_delivery",
          assignmentEpoch: 1,
          sequence: 2,
          state: "pending",
        });
        control.offer({
          type: "input_delivery",
          assignmentEpoch: 1,
          sequence: 2,
          state: "report-unconfirmed",
        });
        control.report(
          run.id,
          1,
          "accepted-final",
          "Completed assignment, not a guidance acknowledgement.",
        );
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        const completed = yield* service.status(run.id);
        expect(completed).toMatchObject({
          state: "completed",
          steeringDelivery: "report-unconfirmed",
          reportGeneration: 1,
        });
        expect(completed.warning).toContain("incorporation remain unconfirmed");
        control.offer({
          type: "input_delivery",
          assignmentEpoch: 1,
          sequence: 2,
          state: "confirmed",
        });
        control.offer({
          type: "input_delivery",
          assignmentEpoch: 2,
          sequence: 3,
          state: "pending",
        });
        yield* Effect.yieldNow;
        expect(yield* service.status(run.id)).toMatchObject({
          state: "completed",
          steeringDelivery: "report-unconfirmed",
          reportGeneration: 1,
        });
      });
    },
  );

  it.effect("stale guidance acknowledgements cannot resolve a newer same-epoch delivery", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest());
      const control = backend.controls[0]!;
      control.offer({ type: "input_delivery", assignmentEpoch: 1, sequence: 1, state: "pending" });
      control.offer({
        type: "input_delivery",
        assignmentEpoch: 1,
        sequence: 1,
        state: "confirmed",
      });
      control.offer({ type: "input_delivery", assignmentEpoch: 1, sequence: 2, state: "pending" });
      control.offer({
        type: "input_delivery",
        assignmentEpoch: 1,
        sequence: 1,
        state: "confirmed",
      });
      control.offer({
        type: "input_delivery",
        assignmentEpoch: 2,
        sequence: 3,
        state: "confirmed",
      });
      control.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "after-stale",
        kind: "progress",
        message: "After stale evidence",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.progress === "After stale evidence");
      expect((yield* service.status(run.id)).steeringDelivery).toBe("pending");
      control.offer({
        type: "input_delivery",
        assignmentEpoch: 1,
        sequence: 2,
        state: "confirmed",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.steeringDelivery === "confirmed");
      expect((yield* service.status(run.id)).state).toBe("running");
    });
  });
  it.effect(
    "keeps a report arriving during start admission queued for exact-once await delivery",
    () => {
      const report = "Report completed while prompt admission was in flight.";
      const initialStartGate = Deferred.makeUnsafe<void>();
      const { backend, projections, notifications, layer } = nativeReportServiceFixture(
        fakeNativeReportBackendLayer({ initialStartGate }),
      );
      return withService(layer, function* (service) {
        const starting = yield* service
          .startSessionOwned(
            nativeReportRequest({
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
        backend.controls[0]?.offer(nativeReportFrame(id!, 1, 1, "report-during-start", report));
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
        expect(started.state).toBe("completed");
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
      const { backend, projections, layer } = nativeReportServiceFixture(resumableBackend());
      return withService(layer, function* (service) {
        const { run, resumeGate, resuming } = yield* pausedUncertainResume(
          service,
          backend,
          "Resume through an uncertain transport.",
        );
        backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
        backend.controls[0]?.offer(
          nativeReportFrame(run.id, 2, 1, "started-before-failure", report),
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
          nativeReportFrame(run.id, 2, 1, "started-before-failure", report),
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
      const { backend, projections, layer } = nativeReportServiceFixture(resumableBackend());
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

  it.effect("keeps a paused resume owner alive after its waiter is cancelled", () => {
    const { backend, projections, layer } = nativeReportServiceFixture(resumableBackend());
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest());
      expect((yield* service.interrupt(run.id)).state).toBe("paused");

      const startGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(startGate);
      const sending = yield* service
        .resume(run.id, "Continue after the caller leaves.")
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
        reportGeneration: 0,
      });
    });
  });

  it.effect(
    "claims close-on-report outcomes and notifies a cancelled resume await exactly once",
    () => {
      const { fake, projections, notifications, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request());
        const waiting = yield* awaitAndConsume(service, [run.id]).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        fake.controls[0]!.settle("First report.");
        const first = yield* Fiber.join(waiting);
        expect(first[0]).toMatchObject({
          run: { state: "completed", reportGeneration: 1, finalText: "First report." },
          completionReceipt: { id: run.id, generation: 1, claimToken: expect.any(String) },
        });
        yield* yieldUntil(() => fake.controls[0]!.released() === 1);
        expect(yield* service.status(run.id)).not.toHaveProperty("finalText");
        expect(projections.at(-1)?.runs[0]?.finalText).toBe("First report.");
        const resumed = yield* service.resume(run.id, "Investigate the follow-up.");
        expect(resumed).toMatchObject({ state: "running", reportGeneration: 1 });
        expect(resumed.finalText).toBeUndefined();
        expect(fake.controls).toHaveLength(2);
        const cancelled = yield* service
          .awaitTerminal([run.id], "all_finished")
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(cancelled);
        fake.controls[1]!.settle("Second report.");
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === 2);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 1);
        expect(notifications[0]).toMatchObject({
          type: "completed",
          runs: [{ id: run.id, generation: 2, finalText: "Second report." }],
        });
        yield* TestClock.adjust("1 second");
        expect(notifications).toHaveLength(1);
        yield* yieldUntil(() => fake.controls[1]!.released() === 1);
      });
    },
  );

  it.effect(
    "delivers a close-on-report success and respawn failure as distinct generations",
    () => {
      const { fake, projections, notifications, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request());
        fake.controls[0]!.settle("First report.");
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 1);
        expect(notifications[0]).toMatchObject({
          type: "completed",
          runs: [{ id: run.id, generation: 1, outcome: "completed" }],
        });
        yield* service.resume(run.id, "Next assignment.");
        fake.controls[1]!.exit(1);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 2);
        expect(notifications[1]).toMatchObject({
          type: "completed",
          runs: [{ id: run.id, generation: 2, outcome: "failed" }],
        });
      });
    },
  );

  it.effect("ignores a report after terminal failure", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest());
      const control = backend.controls[0]!;
      control.offer({ type: "protocol_error", message: "Process failed before report." });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      control.offer(nativeReportFrame(run.id, 1, 1, "late", "Must not resurrect the run."));
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
              const { backend, projections, layer } =
                nativeReportServiceFixture(resumableBackend());
              return withService(layer, function* (service) {
                const run = yield* service.start(nativeReportRequest());
                const control = backend.controls[0]!;
                expect((yield* service.interrupt(run.id)).state).toBe("paused");
                const gate = yield* Deferred.make<void>();
                control.gateNextStart(gate);
                if (outcome !== "success")
                  control.failNextStart(
                    outcome === "uncertain" ? "transport_outcome_uncertain" : undefined,
                  );
                const sending = yield* service
                  .resume(run.id, "Second assignment.")
                  .pipe(Effect.exit, Effect.forkScoped);
                yield* yieldUntil(() => control.assignmentEpochs.at(-1) === 2);
                if (startedObserved) {
                  control.offer({ type: "run_started", assignmentEpoch: 2 });
                  yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
                }
                if (bufferedReport)
                  control.offer(
                    nativeReportFrame(run.id, 2, 2, "buffered", "Must not replace terminal state."),
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
                  reportGeneration: 0,
                  endedAt: before.endedAt,
                });
                expect(after.error).toBe(before.error);
                expect(after.finalText).toBe(before.finalText);
                expect(after.warning).toBe(before.warning);
                expect(control.released()).toBe(1);
              });
            },
          );

  it.effect(
    "settles a paused resume issuing assignment when the backend fails its protocol",
    () => {
      const { backend, projections, layer } = nativeReportServiceFixture(resumableBackend());
      return withService(layer, function* (service) {
        const run = yield* service.start(nativeReportRequest());
        expect((yield* service.interrupt(run.id)).state).toBe("paused");

        const startGate = yield* Deferred.make<void>();
        backend.controls[0]?.gateNextStart(startGate);
        const sending = yield* service
          .resume(run.id, "Start the assignment that will fail closed.")
          .pipe(Effect.forkScoped);
        yield* yieldUntil(
          () =>
            backend.controls[0]?.assignmentEpochs.at(-1) === 2 &&
            projections.at(-1)?.runs[0]?.state === "starting",
        );
        backend.controls[0]?.offer({
          type: "protocol_error",
          message: "Native protocol failed during resume.",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        expect(projections.at(-1)?.runs[0]).toMatchObject({ state: "failed", reportGeneration: 0 });

        yield* Deferred.succeed(startGate, undefined);
        expect(yield* Fiber.join(sending)).toMatchObject({
          state: "failed",
          reportGeneration: 0,
          error: "Native protocol failed during resume.",
        });
        expect((yield* service.status(run.id)).state).toBe("failed");
      });
    },
  );

  it.effect("commits an initial report only after the matching start command confirms", () => {
    const initialStartGate = Deferred.makeUnsafe<void>();
    const { backend, projections, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ initialStartGate }),
    );
    return withService(layer, function* (service) {
      const starting = yield* service.start(nativeReportRequest()).pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      backend.controls[0]?.offer(
        nativeReportFrame(id!, 1, 1, "initial-in-flight", "Fast initial report."),
      );
      yield* Effect.yieldNow;
      expect(projections.at(-1)?.runs[0]?.state).not.toBe("completed");
      yield* Deferred.succeed(initialStartGate, undefined);
      expect(yield* Fiber.join(starting)).toMatchObject({
        state: "completed",
        reportGeneration: 1,
        finalText: "Fast initial report.",
      });
    });
  });

  it.effect("rejects conflicting report sequences without poisoning a valid later delivery", () =>
    Effect.gen(function* () {
      const fields = {
        view: view({ state: "running", closeOnReport: true }),
        stoppedByParent: false,
        warningSlots: {},
        assignment: {
          epoch: 2,
          phase: "running" as const,
          attemptToken: "current",
          startedObserved: true,
          outcomeUncertain: false,
          pendingRunSettled: false as const,
        },
        lastBackendReport: { assignmentEpoch: 1, sequence: 1, deliveryId: "first" },
      } satisfies Pick<
        RunRecord,
        "view" | "stoppedByParent" | "warningSlots" | "assignment" | "lastBackendReport"
      >;
      // SAFETY: Rejection and issuing-phase buffering use only these fields and the launch's
      // absent result contract; no settlement runs.
      const record = { ...fields, launch: {} } as RunRecord;
      // SAFETY: Rejected and buffered reports never enter completion delivery.
      const delivery = {} as RunNotificationDelivery;
      const settlement = makeRunSettlement({
        ...(yield* makeRunContext()),
        delivery,
        closeRecordScope: () => Effect.void,
      });
      yield* settlement.acceptBackendReport(record, {
        runId: record.view.id,
        assignmentEpoch: 2,
        sequence: 1,
        deliveryId: "conflicting",
        text: "Must not commit.",
      });
      expect(record.view.warning).toContain("reused delivery identity");
      expect(record.lastBackendReport).toEqual(fields.lastBackendReport);
      expect(record.view.reportGeneration).toBe(0);
      record.assignment.phase = "issuing";
      const valid = {
        runId: record.view.id,
        assignmentEpoch: 2,
        sequence: 2,
        deliveryId: "second",
        text: "Valid buffered report.",
      };
      yield* settlement.acceptBackendReport(record, valid);
      expect(record.assignment.pendingReport).toEqual(valid);
      expect(record.lastBackendReport?.sequence).toBe(1);
    }),
  );

  it.effect(
    "rejects a second differing in-flight report while the start command is issuing",
    () => {
      const initialStartGate = Deferred.makeUnsafe<void>();
      const { backend, projections, layer } = nativeReportServiceFixture(
        fakeNativeReportBackendLayer({ initialStartGate }),
      );
      return withService(layer, function* (service) {
        const starting = yield* service.start(nativeReportRequest()).pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        backend.controls[0]?.offer(
          nativeReportFrame(id!, 1, 1, "buffered-in-flight", "Buffered in-flight report."),
        );
        backend.controls[0]?.offer(
          nativeReportFrame(id!, 1, 2, "second-in-flight", "Second in-flight report."),
        );
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("more than one in-flight report")),
        );
        expect(projections.at(-1)?.runs[0]?.state).not.toBe("completed");
        yield* Deferred.succeed(initialStartGate, undefined);
        expect(yield* Fiber.join(starting)).toMatchObject({
          state: "completed",
          reportGeneration: 1,
          finalText: "Buffered in-flight report.",
        });
      });
    },
  );

  it.effect("rejects stay-open reports before local admission", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      for (const runtime of ["pi", "claude", "codex"] as const) {
        const failure = yield* service
          .start(request({ runtime, closeOnReport: false }))
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "InvalidSubagentRequestError",
          code: "retained_report_capability_invalid",
        });
      }
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
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

  it.effect("drains close-on-report respawn generations in deterministic batches of twelve", () => {
    const batches: number[][] = [];
    const { fake, projections, layer } = localServiceFixture({
      notify: (notification) => {
        if (notification.type === "completed")
          batches.push(notification.runs.map((run) => run.generation));
        return acknowledgeCompletions(notification);
      },
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const count = MAX_COMPLETION_DELIVERY_BATCH + 1;
      for (let generation = 1; generation <= count; generation++) {
        fake.controls[generation - 1]!.settle(`Report ${generation}.`);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === generation);
        if (generation < count) yield* service.resume(run.id, `Assignment ${generation + 1}.`);
      }
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 1);
      expect(batches[0]).toEqual(
        Array.from({ length: MAX_COMPLETION_DELIVERY_BATCH }, (_, i) => i + 1),
      );
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 2);
      expect(batches[1]).toEqual([count]);
    });
  });

  it.effect("consumes a completed report claim after stop without a later notification", () => {
    const { backend, projections, notifications, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest());
      backend.controls[0]?.report(run.id, 1, "stopped-claim", "Completed before stop.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect((yield* service.stop(run.id)).state).toBe("completed");

      const claimed = yield* service.status(run.id);
      expect(claimed).toMatchObject({ state: "completed", finalText: "Completed before stop." });
      expect(yield* service.status(run.id)).not.toHaveProperty("finalText");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect("keeps an atomically committed completed report deliverable after stop", () => {
    const { backend, projections, notifications, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest());
      backend.controls[0]?.report(
        run.id,
        1,
        "committed-before-stop",
        "Committed before event-fiber cleanup.",
      );
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect((yield* service.stop(run.id)).state).toBe("completed");
      expect(backend.controls[0]?.released()).toBe(1);

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [
          {
            id: run.id,
            generation: 1,
            finalText: "Committed before event-fiber cleanup.",
          },
        ],
      });
    });
  });

  it.effect("lets an accepted close-on-report report settle a pending pause atomically", () => {
    const interruptStarted = Deferred.makeUnsafe<void>();
    const interruptGate = Deferred.makeUnsafe<void>();
    const { backend, projections, notifications, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({
        interruptGate,
        onInterruptStarted: () => Deferred.doneUnsafe(interruptStarted, Effect.void),
        capabilities: ["steer", "interrupt", "rename-display"],
      }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest());
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* Deferred.await(interruptStarted);
      backend.controls[0]?.report(run.id, 1, "report-wins-pause", "Report won the pause race.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
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

  it.effect("closes an active native backend on session shutdown", () => {
    const { backend, layer } = nativeReportServiceFixture();
    return Effect.gen(function* () {
      const run = yield* withService(layer, function* (service) {
        const started = yield* service.start(nativeReportRequest());
        expect(backend.controls[0]!.released()).toBe(0);
        return started;
      });
      expect(run.id).toBeDefined();
      expect(backend.controls[0]!.released()).toBe(1);
    });
  });
});
