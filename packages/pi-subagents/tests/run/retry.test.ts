import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { SubagentBackendRegistry, backendRegistryFor } from "../../src/backend/service.ts";
import { processError, SubagentWriterConflictError } from "../../src/run/errors.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import { getFailedStartRecovery } from "../../src/run/launch.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  fakeChildLayer,
  fakeNativeReportBackendLayer,
  inputDeliveryFrame,
  nativeReportServiceFixture,
  nativeReportRequest,
  request,
  localServiceFixture,
  reviewerContinuation,
  withService,
  awaitRuns,
} from "./fixtures/service-harness.ts";
import { stringContaining } from "../support/matchers.ts";

const reviewerNative = () =>
  nativeReportRequest({ profile: "reviewer", routeContinuation: reviewerContinuation(0) });

const startFailedReviewer = (
  service: SubagentServiceContract,
  fake: ReturnType<typeof fakeChildLayer>,
  overrides: Partial<StartSubagentRequest> = {},
) =>
  Effect.gen(function* () {
    const run = yield* service.start(
      request({ profile: "reviewer", routeContinuation: reviewerContinuation(0), ...overrides }),
    );
    fake.controls[0]?.exit(1);
    yield* yieldUntil(() => fake.controls[0]?.released() === 1);
    return run;
  });

describe("explicit profile-route retry", () => {
  for (const cleanupFailure of [false, true])
    it.effect(
      `terminal unresolved steering blocks retry and notifications with ${cleanupFailure ? "quarantined" : "confirmed"} cleanup`,
      () => {
        const backend = fakeNativeReportBackendLayer();
        const registry = cleanupFailure
          ? Layer.effect(
              SubagentBackendRegistry,
              SubagentBackendRegistry.use((backends) =>
                backends.resolve({ host: "local", runtime: "claude", context: "fresh" }).pipe(
                  Effect.map((driver) =>
                    backendRegistryFor([
                      {
                        ...driver,
                        spawn: (launch) =>
                          driver
                            .spawn(launch)
                            .pipe(
                              Effect.tap(() =>
                                Effect.addFinalizer(() =>
                                  Effect.die(
                                    processError(
                                      "close",
                                      "process_cleanup_unconfirmed",
                                      "Fixture cleanup could not be confirmed.",
                                    ),
                                  ),
                                ),
                              ),
                            ),
                      },
                    ]),
                  ),
                  Effect.orDie,
                ),
              ),
            ).pipe(Layer.provide(backend.layer))
          : backend.layer;
        const { layer, projections, notifications } = nativeReportServiceFixture({
          ...backend,
          layer: registry,
        });
        return withService(layer, function* (service) {
          const run = yield* service.start(reviewerNative());
          const control = backend.controls[0]!;
          control.offer(inputDeliveryFrame(1, 1, "pending"));
          yield* yieldUntil(() => projections.at(-1)?.runs[0]?.steeringDelivery === "pending");
          const failure = processError(
            "steer",
            "steer_outcome_uncertain",
            "Primary acknowledgement watchdog failure.",
          );
          control.offer({ type: "backend_failure", error: failure });
          control.offer({
            type: "exit",
            exitCode: null,
            diagnostic: "Generic exit must not replace the primary cause.",
          });
          yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
          yield* TestClock.adjust("100 millis");
          yield* yieldUntil(() =>
            notifications.some((notification) => notification.type === "completed"),
          );
          yield* service.stop(run.id);
          expect(yield* service.status(run.id)).toMatchObject({
            state: "failed",
            steeringDelivery: "unresolved",
            error: "Primary acknowledgement watchdog failure.",
          });
          expect(yield* Effect.flip(service.claimRetryContinuation(run.id))).toMatchObject({
            code: "retry_outcome_uncertain",
          });
          if (cleanupFailure)
            expect((yield* service.status(run.id)).cleanup?.disposition).toBe("quarantined");
          else expect(control.released()).toBe(1);
          expect(
            notifications.some(
              (notification) =>
                notification.type === "completed" &&
                notification.runs.some((entry) => entry.retryAvailable),
            ),
          ).toBe(false);
        });
      },
    );
  it.effect("acknowledges retry ownership without making its waiter uncancellable", () => {
    const promptGate = Deferred.makeUnsafe<void>();
    const owned = Deferred.makeUnsafe<void>();
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialSendGates: [{ spawnIndex: 1, type: "prompt", gate: promptGate }],
      }),
    );
    return withService(layer, function* (service) {
      const failed = yield* service.start(
        request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
      );
      fake.controls[0]!.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const claim = yield* service.claimRetryContinuation(failed.id);
      const waiting = yield* service
        .startRetrySessionOwned(
          {
            ...request({ profile: "reviewer", routeContinuation: reviewerContinuation(1) }),
            supersedes: { runId: failed.id, claimToken: claim.claimToken },
          },
          () => {
            Deferred.doneUnsafe(owned, Effect.void);
          },
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(owned);
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(promptGate, undefined);
      yield* yieldUntil(() => fake.controls.length === 2);
      const successorId = (yield* service.status(failed.id)).supersededByRunId!;
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some((run) => run.id === successorId && run.state === "running") === true,
      );
      expect((yield* service.status(successorId)).state).toBe("running");
      expect((yield* service.status(failed.id)).supersededByRunId).toBe(successorId);
    });
  });

  it.effect("admits one linked successor and atomically supersedes the failed predecessor", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failedRun = yield* service.start(
        request({
          profile: "reviewer",
          routeContinuation: reviewerContinuation(0),
          selection: {
            source: "profile-candidate",
            routeSource: "global",
            candidateIndex: 0,
            reason: "Profile reviewer selected candidate 1.",
            skippedCandidates: [],
          },
        }),
      );
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial analysis is not a report" }],
          stopReason: "error",
          errorMessage: "RESOURCE_EXHAUSTED: exhausted your capacity",
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      fake.controls[0]?.exit(0);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const [failed] = yield* service.list;
      expect(failed).toMatchObject({
        state: "failed",
        reportGeneration: 0,
      });
      expect(failed?.finalText).toBeUndefined();
      expect(failed?.error).toContain("RESOURCE_EXHAUSTED");
      expect(fake.controls).toHaveLength(1);

      const claim = yield* service.claimRetryContinuation(failedRun.id);
      const conflicting = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(conflicting).toMatchObject({ code: "retry_claim_conflict" });

      const successor = yield* service.startRetrySessionOwned({
        ...request({
          name: failedRun.name,
          task: failedRun.task,
          profile: "reviewer",
          routeContinuation: reviewerContinuation(1, [
            {
              candidateIndex: 0,
              candidate: "local/pi/openai-codex/gpt-5.6-sol",
              code: "previous_run_failed",
              reason: "Candidate 1 failed in the predecessor.",
            },
          ]),
          selection: {
            source: "profile-parent-candidate",
            routeSource: "global",
            candidateIndex: 1,
            reason: `Profile reviewer continued failed run ${failedRun.id} with candidate 2.`,
            skippedCandidates: [],
          },
        }),
        supersedes: { runId: failedRun.id, claimToken: claim.claimToken },
      });

      expect(successor).toMatchObject({
        predecessorRunId: failedRun.id,
        profile: "reviewer",
        task: failedRun.task,
        remainingCandidateCount: 0,
        selection: { candidateIndex: 1 },
      });
      expect(yield* service.status(failedRun.id)).toMatchObject({
        state: "failed",
        supersededByRunId: successor.id,
      });
      const alreadySuperseded = yield* service
        .claimRetryContinuation(failedRun.id)
        .pipe(Effect.flip);
      expect(alreadySuperseded).toMatchObject({ code: "retry_already_superseded" });
    });
  });

  it.effect("waits for confirmed cleanup before granting the retry claim", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failedRun = yield* service.start(
        request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
      );
      const cleanupGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateRelease(cleanupGate);
      fake.controls[0]?.exit(1);
      yield* awaitRuns(service, [failedRun.id], "all_finished");
      const claimed = yield* Deferred.make<void>();
      const claiming = yield* service.claimRetryContinuation(failedRun.id).pipe(
        Effect.tap(() => Deferred.succeed(claimed, undefined)),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(claimed)).toBe(false);
      yield* Deferred.succeed(cleanupGate, undefined);
      const claim = yield* Fiber.join(claiming);
      expect(claim.source.id).toBe(failedRun.id);
      yield* service.releaseRetryClaim(failedRun.id, claim.claimToken);
    });
  });

  it.effect("refuses continuation after uncertain task delivery", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialTransportFailures: [
          { spawnIndex: 0, type: "prompt", code: "transport_outcome_uncertain" },
        ],
      }),
    );
    return withService(layer, function* (service) {
      const failure = yield* service
        .start(request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }))
        .pipe(Effect.flip);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failedRun = (yield* service.list)[0]!;
      expect(getFailedStartRecovery(failure)).toMatchObject({
        runId: failedRun.id,
        cleanupDisposition: "confirmed",
        retryDisposition: "blocked",
        hasRemainingCandidate: true,
      });
      const blocked = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(blocked).toMatchObject({ code: "retry_outcome_uncertain" });
    });
  });

  it.effect("blocks initial-task replay after an interrupted assignment resumes and fails", () => {
    const { fake, layer, notifications } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(
        request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
      );
      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      expect(
        yield* service.resume(run.id, "Review a different task; do not replay the original."),
      ).toMatchObject({
        state: "running",
        assignmentEpoch: 2,
        reportGeneration: 0,
      });
      fake.controls[0]!.exit(1);
      yield* yieldUntil(() => fake.controls[0]!.released() === 1);

      expect(yield* Effect.flip(service.claimRetryContinuation(run.id))).toMatchObject({
        code: "retry_assignment_not_initial",
      });
      const observed = yield* service.withStatusObservations([run.id], ({ observations }) =>
        Effect.succeed(observations[0]),
      );
      expect(observed?.recovery).toMatchObject({
        cleanupDisposition: "confirmed",
        retryDisposition: "blocked",
        hasRemainingCandidate: true,
      });
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.some((notice) => notice.type === "completed"));
      const completions = notifications.flatMap((notice) =>
        notice.type === "completed" ? notice.runs : [],
      );
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ id: run.id, outcome: "failed" });
      expect(completions[0]?.retryAvailable).toBeUndefined();
    });
  });

  it.effect("reserves a failed writer's exact claims while retry resolution is in progress", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failedRun = yield* startFailedReviewer(service, fake, {
        profile: "worker",
        writeIntent: "writer",
        writes: ["src/retry-owner.ts"],
      });
      const claim = yield* service.claimRetryContinuation(failedRun.id);

      const conflict = yield* service
        .start(
          request({
            name: "retry-claim-collision",
            writeIntent: "writer",
            writes: ["src/RETRY-owner.ts"],
          }),
        )
        .pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(SubagentWriterConflictError);
      expect(conflict).toMatchObject({
        activeId: failedRun.id,
        message: stringContaining("route retry"),
      });
      const disjoint = yield* service.start(
        request({
          name: "retry-claim-disjoint",
          writeIntent: "writer",
          writes: ["src/disjoint.ts"],
        }),
      );
      expect(disjoint.state).toBe("running");
      yield* service.releaseRetryClaim(failedRun.id, claim.claimToken);
    });
  });

  it.effect("publishes exhaustion and blocks repeated continuation", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failedRun = yield* startFailedReviewer(service, fake);
      const claim = yield* service.claimRetryContinuation(failedRun.id);
      yield* service.exhaustRetryClaim(failedRun.id, claim.claimToken);
      expect(yield* service.status(failedRun.id)).toMatchObject({ retryExhausted: true });
      const exhausted = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(exhausted).toMatchObject({ code: "retry_route_exhausted" });
    });
  });
});
