import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { processError } from "../../src/run/errors.ts";
import { MAX_ERROR_CHARS } from "../../src/run/state.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  assistantMessageEndFrame,
  awaitObservations,
  awaitRuns,
  fakeEventBackendLayer,
  localServiceFixture,
  eventBackendRequest,
  eventBackendServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import { anyString } from "../support/matchers.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

describe("local Pi terminal evidence", () => {
  for (const stopReason of ["error", "stop", undefined] as const) {
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
          const result = yield* runView(service, run.id);
          expect(result).toMatchObject({ state: "failed", reportGeneration: 0 });
          expect(result.finalText).toBeUndefined();
          expect(result.error).toContain("writes may already exist");
          expect(result.error).not.toContain("\u001b");
          if (stopReason === "error") expect(result.error).toContain("Provider unavailable.");
          if (stopReason !== undefined && stopReason !== "stop")
            expect(result.error).toContain("Partial output before the failure: Partial work.");
          expect(result.error).not.toContain("Earlier success must not leak.");
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
      expect((yield* runView(service, run.id)).state).toBe("running");
      fake.controls[0]!.offer({ type: "agent_start" });
      fake.controls[0]!.settle("Recovered report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect(yield* runView(service, run.id)).toMatchObject({
        state: "completed",
        reportGeneration: 1,
        finalText: "Recovered report.",
      });
    });
  });
});

const rawPrimary = () =>
  processError(
    "steer",
    "guidance_outcome_uncertain",
    `Primary acknowledgement failure token=secret-credential \u001b[31m${Fn.pipe("x", Str.repeat(9000))}`,
  );

const expectSanitized = (text: string | undefined) => {
  expect(text).toContain("Primary acknowledgement failure");
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("secret-credential");
  expect(text).not.toContain("\u001b");
  expect(text?.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
};

describe("primary failure privacy", () => {
  for (const source of ["protocol", "exit"] as const)
    it.effect(`redacts and bounds the primary ${source} error before public run projection`, () => {
      const { backend, projections, layer } = eventBackendServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(eventBackendRequest());
        const primary = rawPrimary();
        backend.controls[0]!.offer(
          source === "protocol"
            ? { type: "protocol_error", message: primary.message }
            : { type: "exit", exitCode: null, diagnostic: "generic exit", failure: primary },
        );
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        expectSanitized((yield* runView(service, run.id)).error);
        for (const projection of projections) {
          const error = projection.runs[0]?.error;
          if (error) expectSanitized(error);
        }
      });
    });
});

describe("SubagentService", () => {
  it.effect(
    "keeps a report arriving during start admission queued for exact-once await delivery",
    () => {
      const report = "Report completed while prompt admission was in flight.";
      const initialStartGate = Deferred.makeUnsafe<void>();
      const { backend, projections, notifications, layer } = eventBackendServiceFixture(
        fakeEventBackendLayer({ initialStartGate }),
      );
      return withService(layer, function* (service) {
        const starting = yield* service
          .startSessionOwned(eventBackendRequest({ name: "fast-report" }))
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
        backend.controls[0]?.complete(report);
        yield* yieldUntil(() =>
          Arr.last(projections).pipe(
            Option.flatMap((projection) => Arr.head(projection.runs)),
            Option.exists((run) =>
              Arr.some(
                run.sessionEvents,
                (event) => event.type === "assistant" && event.text === report,
              ),
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

        const delivered = yield* awaitObservations(service, [started.id]);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.run.finalText).toBe(report);
        expect(delivered[0]?.run.sessionEvents).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "assistant", text: report })]),
        );

        yield* TestClock.adjust("1 second");
        expect(notifications).toEqual([]);
      });
    },
  );

  it.effect(
    "claims close-on-report outcomes and notifies a cancelled resume await exactly once",
    () => {
      const { fake, projections, notifications, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request());
        const waiting = yield* awaitObservations(service, [run.id]).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        fake.controls[0]!.settle("First report.");
        const first = yield* Fiber.join(waiting);
        expect(first[0]).toMatchObject({
          run: { state: "completed", reportGeneration: 1, finalText: "First report." },
          completionReceipt: { id: run.id, generation: 1, claimToken: anyString() },
        });
        yield* yieldUntil(() => fake.controls[0]!.released() === 1);
        expect(projections.at(-1)?.runs[0]?.finalText).toBe("First report.");
        const resumed = yield* service.resume(run.id, "Investigate the follow-up.");
        expect(resumed).toMatchObject({ state: "running", reportGeneration: 1 });
        expect(resumed.finalText).toBeUndefined();
        expect(fake.controls).toHaveLength(2);
        const cancelled = yield* awaitRuns(service, [run.id], "all_finished").pipe(
          Effect.forkScoped,
        );
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

  it.effect("ignores a report after terminal failure", () => {
    const { backend, projections, layer } = eventBackendServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(eventBackendRequest());
      const control = backend.controls[0]!;
      control.offer({ type: "protocol_error", message: "Process failed before report." });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      control.complete("Must not resurrect the run.");
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      expect(yield* runView(service, run.id)).toMatchObject({
        state: "failed",
        reportGeneration: 0,
      });
    });
  });

  it.effect("commits an initial report only after the matching start command confirms", () => {
    const initialStartGate = Deferred.makeUnsafe<void>();
    const { backend, projections, layer } = eventBackendServiceFixture(
      fakeEventBackendLayer({ initialStartGate }),
    );
    return withService(layer, function* (service) {
      const starting = yield* service.start(eventBackendRequest()).pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
      backend.controls[0]?.complete("Fast initial report.");
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

  it.effect("keeps an atomically committed completed report deliverable after stop", () => {
    const { backend, projections, notifications, layer } = eventBackendServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(eventBackendRequest());
      backend.controls[0]?.complete("Committed before event-fiber cleanup.");
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

  it.effect("closes an active native backend on session shutdown", () => {
    const { backend, layer } = eventBackendServiceFixture();
    return Effect.gen(function* () {
      const run = yield* withService(layer, function* (service) {
        const started = yield* service.start(eventBackendRequest());
        expect(backend.controls[0]!.released()).toBe(0);
        return started;
      });
      expect(run.id).toBeDefined();
      expect(backend.controls[0]!.released()).toBe(1);
    });
  });
});
