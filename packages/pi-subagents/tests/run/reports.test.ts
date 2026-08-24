// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import { MAX_COMPLETION_DELIVERY_BATCH } from "../../src/run/limits.ts";
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
  it.effect(
    "keeps a report arriving during start admission queued for exact-once await delivery",
    () => {
      const report = "Report completed while prompt admission was in flight.";
      const initialStartGate = Deferred.makeUnsafe<void>();
      const backend = fakeRetainedBackendLayer({ initialStartGate });
      const projections: SubagentProjection[] = [];
      const notifications: SubagentNotification[] = [];
      const layer = retainedServiceLayer(backend, {
        notify: (notification) => void notifications.push(notification),
        publish: (projection) => void projections.push(projection),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .startSessionOwned(
            request({
              name: "fast-report",
              host: "herdr",
              runtime: "claude",
              closeOnReport: false,
              model: "claude-retained",
              effortWasExplicit: false,
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
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
          },
        });
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: id!,
          sequence: 1,
          deliveryId: "report-during-start",
          text: report,
        });
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

        const delivered = yield* service.withAwaitTerminalObservations(
          [started.id],
          "all_finished",
          undefined,
          (observations) =>
            service
              .consumeCompletions(
                observations.flatMap((observation) =>
                  observation.completionReceipt ? [observation.completionReceipt] : [],
                ),
              )
              .pipe(Effect.as(observations)),
        );
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.run.finalText).toBe(report);
        expect(delivered[0]?.run.sessionEvents).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "assistant", text: report })]),
        );

        yield* TestClock.adjust("1 second");
        expect(notifications).toEqual([]);
        expect(yield* service.status(started.id)).not.toHaveProperty("finalText");
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("starts retained follow-ups without advertising unconfirmable active steering", () => {
    const backend = fakeRetainedBackendLayer({ capabilities: ["rename-display"] });
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      const activeGuidanceFailure = yield* service
        .send(run.id, "Unconfirmed active guidance")
        .pipe(Effect.flip);
      expect(activeGuidanceFailure).toMatchObject({
        _tag: "UnsupportedSubagentCapabilityError",
        capability: "steer",
      });

      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "retained-without-steer",
        text: "First retained report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      const followUp = yield* service.send(run.id, "Begin a new retained assignment.");
      expect(followUp).toMatchObject({ state: "running", reportGeneration: 1 });
      expect(backend.controls[0]?.prompts.at(-1)).toBe("Begin a new retained assignment.");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "claims retained reports, deduplicates delivery, begins the next assignment, and notifies a cancelled await exactly once",
    () => {
      const backend = fakeRetainedBackendLayer();
      const projections: SubagentProjection[] = [];
      const notifications: SubagentNotification[] = [];
      const layer = retainedServiceLayer(backend, {
        publish: (projection) => projections.push(projection),
        notify: (notification) => void notifications.push(notification),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        );
        expect(run).toMatchObject({ state: "running", reportGeneration: 0, pid: 22_001 });
        expect(backend.controls[0]?.prompts).toHaveLength(1);

        const firstAwait = yield* service
          .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
            service
              .consumeCompletions(
                observations.flatMap((observation) =>
                  observation.completionReceipt ? [observation.completionReceipt] : [],
                ),
              )
              .pipe(Effect.as(observations)),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 1,
          deliveryId: "report-one",
          evidence: "fixture-owned-pane",
          text: "First retained report.",
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
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 1,
          deliveryId: "report-one",
          text: "Duplicate must be ignored.",
        });
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
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 2,
          deliveryId: "report-two",
          text: "Second retained report.",
        });
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
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("delivers a retained report and later failure as distinct outcome generations", () => {
    const backend = fakeRetainedBackendLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          name: "retained-failure-generation",
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "retained-success",
        text: "First report.",
      });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("commits an initial report only after the matching start command confirms", () => {
    const initialStartGate = Deferred.makeUnsafe<void>();
    const backend = fakeRetainedBackendLayer({ initialStartGate });
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      backend.controls[0]?.offer({
        type: "report",
        assignmentEpoch: 1,
        runId: id!,
        sequence: 1,
        deliveryId: "initial-in-flight",
        text: "Fast initial report.",
      });
      yield* Effect.yieldNow;
      expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
      yield* Deferred.succeed(initialStartGate, undefined);
      expect(yield* Fiber.join(starting)).toMatchObject({
        state: "reported",
        reportGeneration: 1,
        finalText: "Fast initial report.",
      });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "buffers an in-flight retained report and does not poison its later valid retry",
    () => {
      const backend = fakeRetainedBackendLayer();
      const projections: SubagentProjection[] = [];
      const layer = retainedServiceLayer(backend, {
        publish: (projection) => projections.push(projection),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        );
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 1,
          deliveryId: "first-delivery",
          text: "First assignment.",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
        expect((yield* service.status(run.id)).finalText).toBe("First assignment.");

        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: run.id,
          sequence: 2,
          deliveryId: "second-delivery",
          text: "Too early.",
        });
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

        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: run.id,
          sequence: 1,
          deliveryId: "first-delivery",
          text: "Exact retry with changed text is ignored.",
        });
        const startGate = yield* Deferred.make<void>();
        backend.controls[0]?.gateNextStart(startGate);
        const sending = yield* service
          .send(run.id, "Begin the second assignment.")
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.prompts.length === 2);
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 2,
          runId: run.id,
          sequence: 2,
          deliveryId: "second-delivery",
          text: "Second assignment committed after start.",
        });
        yield* Effect.yieldNow;
        expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
        yield* Deferred.succeed(startGate, undefined);
        expect(yield* Fiber.join(sending)).toMatchObject({
          state: "reported",
          reportGeneration: 2,
          finalText: "Second assignment committed after start.",
        });
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("rejects a reused report sequence with a conflicting delivery identity", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "first-delivery",
        text: "First assignment.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      yield* service.send(run.id, "Begin the second assignment.");
      backend.controls[0]?.offer({
        type: "report",
        assignmentEpoch: 2,
        runId: run.id,
        sequence: 1,
        deliveryId: "conflicting-delivery",
        text: "Conflicting delivery-identity reuse.",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("reused delivery identity")),
      );
      expect(projections.at(-1)?.runs[0]).toMatchObject({
        state: "running",
        reportGeneration: 1,
      });

      backend.controls[0]?.offer({
        type: "report",
        assignmentEpoch: 2,
        runId: run.id,
        sequence: 2,
        deliveryId: "second-delivery",
        text: "Second assignment.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === 2);
      expect((yield* service.status(run.id)).finalText).toBe("Second assignment.");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "rejects a second differing in-flight report while the start command is issuing",
    () => {
      const initialStartGate = Deferred.makeUnsafe<void>();
      const backend = fakeRetainedBackendLayer({ initialStartGate });
      const projections: SubagentProjection[] = [];
      const layer = retainedServiceLayer(backend, {
        publish: (projection) => projections.push(projection),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(
            request({
              host: "herdr",
              runtime: "claude",
              closeOnReport: false,
              model: "claude-retained",
              effortWasExplicit: false,
            }),
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: id!,
          sequence: 1,
          deliveryId: "buffered-in-flight",
          text: "Buffered in-flight report.",
        });
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: id!,
          sequence: 2,
          deliveryId: "second-in-flight",
          text: "Second in-flight report.",
        });
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
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("rejects retained reports outside Herdr read-only backends before admission", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service.start(request({ closeOnReport: false })).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "retained_report_capability_invalid",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("reserves generation 64 for terminal failure after 63 retained reports", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      notify: (notification) =>
        notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined,
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      for (let generation = 1; generation <= 63; generation += 1) {
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: generation,
          deliveryId: `backlog-${generation}`,
          text: `Backlog report ${generation}.`,
        });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("caps resumed runs at 64 unresolved report generations", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) =>
        notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined,
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-backlog" }));
      for (let generation = 1; generation <= 64; generation += 1) {
        fake.controls[generation - 1]?.offer({ type: "agent_settled" });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("rolls back a raced retained start and never reuses its assignment epoch", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "rollback-report",
        text: "Preserve this report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

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
      expect(rolledBack.warning).toBeUndefined();
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps outcome-uncertain retained work and ignores idle assignment events", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "idle-report",
        text: "Idle report.",
      });
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
      backend.controls[0]?.offer({
        type: "report",
        assignmentEpoch: 2,
        runId: run.id,
        sequence: 2,
        deliveryId: "uncertain-report",
        text: "Applied despite uncertain response.",
      });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("drains completion generations in deterministic batches of twelve", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const batches: number[][] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        batches.push(notification.runs.map((run) => run.generation));
        return {
          deliveredCompletionKeys: notification.runs.map((run) => `${run.id}:${run.generation}`),
        };
      },
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      const generationCount = MAX_COMPLETION_DELIVERY_BATCH + 1;
      for (let generation = 1; generation <= generationCount; generation += 1) {
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: generation,
          runId: run.id,
          sequence: generation,
          deliveryId: `batch-${generation}`,
          text: `Report ${generation}.`,
        });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("consumes a stopped retained report claim without a later notification", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const notifications: SubagentNotification[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
      notify: (notification) => void notifications.push(notification),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "stopped-claim",
        text: "Retained before stop.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      expect((yield* service.stop(run.id)).state).toBe("stopped");

      const claimed = yield* service.status(run.id);
      expect(claimed).toMatchObject({ state: "stopped", finalText: "Retained before stop." });
      expect(yield* service.status(run.id)).not.toHaveProperty("finalText");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps an atomically committed retained report deliverable after stop", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const notifications: SubagentNotification[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
      notify: (notification) => void notifications.push(notification),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "committed-before-stop",
        text: "Committed before event-fiber cleanup.",
      });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("lets an accepted retained report settle a pending pause atomically", () => {
    const interruptStarted = Deferred.makeUnsafe<void>();
    const interruptGate = Deferred.makeUnsafe<void>();
    const backend = fakeRetainedBackendLayer({
      interruptGate,
      onInterruptStarted: () => Deferred.doneUnsafe(interruptStarted, Effect.void),
      capabilities: ["steer", "interrupt", "rename-display"],
    });
    const projections: SubagentProjection[] = [];
    const notifications: SubagentNotification[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
      notify: (notification) => void notifications.push(notification),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* Deferred.await(interruptStarted);
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "report-wins-pause",
        text: "Report won the pause race.",
      });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("closes an idle retained backend on session shutdown", () => {
    const backend = fakeRetainedBackendLayer();
    const layer = retainedServiceLayer(backend);
    return Effect.gen(function* () {
      const run = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const started = yield* service.start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        );
        backend.controls[0]?.offer({
          type: "report",
          runId: started.id,
          sequence: 1,
          deliveryId: "shutdown-report",
          text: "Idle now.",
        });
        yield* yieldUntil(() =>
          Boolean(backend.controls[0] && backend.controls[0].released() === 0),
        );
        return started;
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
      expect(run.id).toBeDefined();
      expect(backend.controls[0]?.released()).toBe(1);
    });
  });
});
