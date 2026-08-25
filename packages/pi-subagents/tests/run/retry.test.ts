// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { ProfileCandidate, ProfileRouteContinuation } from "../../src/profiles/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { fakeChildLayer, request, serviceLayer } from "./fixtures/service-harness.ts";

const candidate = (model: string): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  closeOnReport: true,
});

const continuation = (
  selectedCandidateIndex: number,
  skippedCandidates: ProfileRouteContinuation["skippedCandidates"] = [],
): ProfileRouteContinuation => ({
  profile: "reviewer",
  routeSource: "global",
  candidates: [candidate("openai-codex/gpt-5.6-sol"), candidate("parent")],
  selectedCandidateIndex,
  skippedCandidates,
});

describe("explicit profile-route retry", () => {
  it.effect("admits one linked successor and atomically supersedes the failed predecessor", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({
          profile: "reviewer",
          routeContinuation: continuation(0),
          selection: {
            source: "profile-candidate",
            routeSource: "global",
            host: "local",
            runtime: "pi",
            closeOnReport: true,
            candidateIndex: 0,
            reason: "Profile reviewer selected candidate 1.",
            skippedCandidates: [],
          },
        }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      const claim = yield* service.claimRetryContinuation(failedRun.id);
      const conflicting = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(conflicting).toMatchObject({ code: "retry_claim_conflict" });

      const successor = yield* service.startRetrySessionOwned({
        ...request({
          name: failedRun.name,
          task: failedRun.task,
          profile: "reviewer",
          routeContinuation: continuation(1, [
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
            host: "local",
            runtime: "pi",
            closeOnReport: true,
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("waits for confirmed cleanup before granting the retry claim", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({ profile: "reviewer", routeContinuation: continuation(0) }),
      );
      const cleanupGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateRelease(cleanupGate);
      fake.controls[0]?.exit(1);
      yield* service.awaitTerminal([failedRun.id], "all_finished");
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("releases the predecessor claim when successor admission never starts", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({ profile: "reviewer", routeContinuation: continuation(0) }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const claim = yield* service.claimRetryContinuation(failedRun.id);
      const failure = yield* service
        .startRetrySessionOwned({
          ...request({ host: "herdr", runtime: "claude" }),
          supersedes: { runId: failedRun.id, claimToken: claim.claimToken },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "backend_not_implemented" });
      const reclaimed = yield* service.claimRetryContinuation(failedRun.id);
      expect(reclaimed.claimToken).not.toBe(claim.claimToken);
      yield* service.releaseRetryClaim(failedRun.id, reclaimed.claimToken);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("revalidates the exclusive predecessor claim at successor admission", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({ profile: "reviewer", routeContinuation: continuation(0) }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const claim = yield* service.claimRetryContinuation(failedRun.id);
      yield* service.releaseRetryClaim(failedRun.id, claim.claimToken);
      const stale = yield* service
        .startRetrySessionOwned({
          ...request({ routeContinuation: continuation(1) }),
          supersedes: { runId: failedRun.id, claimToken: claim.claimToken },
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ code: "retry_claim_stale" });
      expect(yield* service.list).toHaveLength(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("refuses continuation after uncertain task delivery", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialTransportFailures: [
        { spawnIndex: 0, type: "prompt", code: "transport_outcome_uncertain" },
      ],
    });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service
        .start(request({ profile: "reviewer", routeContinuation: continuation(0) }))
        .pipe(Effect.flip);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failedRun = (yield* service.list)[0]!;
      const blocked = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(blocked).toMatchObject({ code: "retry_outcome_uncertain" });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("blocks continuation when failed-run cleanup is quarantined", () => {
    const fake = fakeChildLayer(Effect.void, { releaseDefect: true });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({ profile: "reviewer", routeContinuation: continuation(0) }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const blocked = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(blocked).toMatchObject({ code: "retry_cleanup_unconfirmed" });
      expect((yield* service.status(failedRun.id)).warning).toContain("quarantined");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("reserves a failed writer's exact claims while retry resolution is in progress", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({
          profile: "worker",
          writeIntent: "writer",
          writes: ["src/retry-owner.ts"],
          routeContinuation: continuation(0),
        }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
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
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: failedRun.id,
        message: expect.stringContaining("route retry"),
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("publishes exhaustion and blocks repeated continuation", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({ profile: "reviewer", routeContinuation: continuation(0) }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const claim = yield* service.claimRetryContinuation(failedRun.id);
      yield* service.exhaustRetryClaim(failedRun.id, claim.claimToken);
      expect(yield* service.status(failedRun.id)).toMatchObject({ retryExhausted: true });
      const exhausted = yield* service.claimRetryContinuation(failedRun.id).pipe(Effect.flip);
      expect(exhausted).toMatchObject({ code: "retry_route_exhausted" });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
