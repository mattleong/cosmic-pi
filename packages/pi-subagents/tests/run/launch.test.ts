import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentRunView } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  completeLocalRun,
  fakeChildLayer,
  localServiceFixture,
  request,
  reviewerContinuation,
  runView,
  runViews,
  withService,
} from "./fixtures/service-harness.ts";
import {
  SubagentNotFoundError,
  SubagentCapacityError,
  SubagentProcessError,
} from "../../src/run/errors.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const completeHistory = (
  service: SubagentServiceContract,
  fake: ReturnType<typeof fakeChildLayer>,
  count: number,
  prefix: string,
  offset = 0,
) =>
  Effect.gen(function* () {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const run = yield* service.start(request({ name: `${prefix}-${index + 1}` }));
      ids.push(run.id);
      yield* completeLocalRun(
        service,
        fake.controls[index + offset]!,
        run.id,
        `Report ${index + 1}`,
      );
    }
    return ids;
  });

// Run IDs fit every agent ID bound: alphanumeric start, at most 80 characters.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
describe("SubagentService", () => {
  it.effect("records each launch's next frozen route candidate", () =>
    withService(localServiceFixture().layer, function* (service) {
      const first = yield* service.start(request({ routeContinuation: reviewerContinuation(0) }));
      const last = yield* service.start(request({ routeContinuation: reviewerContinuation(1) }));
      const unrouted = yield* service.start(request());
      expect(first.nextCandidate).toEqual({ model: "parent", effort: "high" });
      expect(last.nextCandidate).toBe("none");
      expect(unrouted.nextCandidate).toBeUndefined();
    }),
  );

  it.effect("namespaces run IDs across runtime replacement and rejects stale IDs", () =>
    Effect.gen(function* () {
      const first = yield* withService(localServiceFixture().layer, function* (service) {
        return yield* service.start(request());
      });
      const result = yield* withService(localServiceFixture().layer, function* (service) {
        const second = yield* service.start(request());
        const stale = yield* runView(service, first.id).pipe(Effect.flip);
        return { second, stale };
      });

      expect(first.id).toMatch(RUN_ID);
      expect(result.second.id).toMatch(RUN_ID);
      expect(result.second.id).not.toBe(first.id);
      expect(result.stale).toBeInstanceOf(SubagentNotFoundError);
      expect(result.stale).toMatchObject({ id: first.id });
    }),
  );

  it.effect("allocates concurrent unnamed IDs, ordinals, and fallback names atomically", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const runs = yield* Effect.all(
        Array.from({ length: 12 }, () => service.start(request({ name: undefined }))),
        { concurrency: "unbounded" },
      );
      expect(new Set(Arr.map(runs, (run) => run.id)).size).toBe(12);
      expect(new Set(Arr.map(runs, (run) => run.name))).toEqual(
        new Set(Arr.makeBy(12, (index) => `subagent-${index + 1}`)),
      );
    });
  });

  it.effect("mints run IDs a model can't predict from an earlier start", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(request({ name: undefined }));
      const second = yield* service.start(request({ name: undefined }));
      // A random token, with no runtime namespace or ordinal to increment.
      for (const run of [first, second]) expect(run.id).toMatch(/^agent-[0-9a-z]{10}$/u);
      expect(second.id).not.toBe(first.id);
      expect([first.name, second.name]).toEqual(["subagent-1", "subagent-2"]);
    });
  });

  it.effect(
    "keeps direct-child capacity reserved until terminal process cleanup is confirmed",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const runs: SubagentRunView[] = [];
        for (let index = 0; index < 12; index += 1)
          runs.push(yield* service.start(request({ name: `active-${index + 1}` })));
        expect(fake.controls).toHaveLength(12);

        const activeSaturation = yield* service
          .start(request({ name: "thirteenth-active" }))
          .pipe(Effect.flip);
        expect(activeSaturation).toBeInstanceOf(SubagentCapacityError);
        expect(activeSaturation).toMatchObject({ limit: 12 });
        expect(activeSaturation.message).toContain("Stop an active run");
        expect(fake.controls).toHaveLength(12);

        const cleanupGate = yield* Deferred.make<void>();
        fake.controls[0]?.gateRelease(cleanupGate);
        fake.controls[0]?.settle();
        yield* yieldUntil(() =>
          Option.exists(Arr.last(projections), (projection) =>
            Arr.some(
              projection.runs,
              (candidate) => candidate.id === runs[0]?.id && candidate.state === "completed",
            ),
          ),
        );
        const blockedDuringCleanup = yield* service
          .start(request({ name: "blocked-during-cleanup" }))
          .pipe(Effect.flip);
        expect(blockedDuringCleanup).toBeInstanceOf(SubagentCapacityError);
        expect(blockedDuringCleanup).toMatchObject({ limit: 12 });
        expect(fake.controls).toHaveLength(12);

        yield* Deferred.succeed(cleanupGate, undefined);
        yield* yieldUntil(() => fake.controls[0]?.released() === 1);
        const admittedAfterCleanup = yield* service.start(
          request({ name: "admitted-after-cleanup" }),
        );
        expect(admittedAfterCleanup.state).toBe("running");
        expect(fake.controls).toHaveLength(13);
      });
    },
  );

  it.effect("keeps the evicted record registered and admits nothing when reclaim fails", () => {
    let reclaimFails = true;
    const fake = fakeChildLayer(Effect.void, {
      get failReclaim() {
        return reclaimFails;
      },
    });
    const { layer } = localServiceFixture({}, fake);
    return withService(layer, function* (service) {
      const firstId = (yield* completeHistory(service, fake, 50, "evictable"))[0]!;
      yield* TestClock.adjust("100 millis");
      const blocked = yield* service.start(request({ name: "blocked" })).pipe(Effect.flip);
      expect(blocked).toBeInstanceOf(SubagentProcessError);
      expect(blocked).toMatchObject({ code: "fixture_reclaim_failed" });
      const afterFailure = yield* runViews(service);
      const secondId = afterFailure[1]?.id ?? "";
      const thirdId = afterFailure[2]?.id ?? "";
      expect(afterFailure).toHaveLength(50);
      expect(
        Option.getOrUndefined(Arr.findFirst(afterFailure, (run) => run.id === firstId))?.cleanup,
      ).toMatchObject({
        disposition: "quarantined",
        recovery: "manual",
        diagnostic: { phase: "backend-scope", code: "fixture_reclaim_failed" },
      });
      expect(Arr.some(afterFailure, (run) => run.name === "blocked")).toBe(false);
      expect(fake.reclaimedRunIds).toEqual([firstId]);
      const retried = yield* service.start(request({ name: "blocked-retry" })).pipe(Effect.flip);
      expect(retried).toMatchObject({ code: "fixture_reclaim_failed" });
      expect(fake.reclaimedRunIds).toEqual([firstId, secondId]);
      reclaimFails = false;
      const recovered = yield* service.start(request({ name: "recovered" }));
      expect(recovered.state).toBe("running");
      const retained = yield* runViews(service);
      expect(retained).toHaveLength(50);
      expect(Arr.some(retained, (run) => run.id === firstId)).toBe(true);
      expect(Arr.some(retained, (run) => run.id === secondId)).toBe(true);
      expect(Arr.some(retained, (run) => run.id === thirdId)).toBe(false);
    });
  });

  it.effect("concurrent evicting starts never claim the same reclaim candidate", () => {
    let gate: Deferred.Deferred<void> | undefined;
    const fake = fakeChildLayer(Effect.void, {
      get reclaimGate() {
        return gate;
      },
    });
    const { layer } = localServiceFixture({}, fake);
    return withService(layer, function* (service) {
      for (let index = 0; index < 10; index += 1)
        yield* service.start(request({ name: `active-before-eviction-${index + 1}` }));
      yield* completeHistory(service, fake, 50, "candidate", 10);
      yield* TestClock.adjust("100 millis");
      gate = yield* Deferred.make<void>();
      const startA = yield* service.start(request({ name: "evict-a" })).pipe(Effect.forkScoped);
      const startB = yield* service.start(request({ name: "evict-b" })).pipe(Effect.forkScoped);
      yield* yieldUntil(() => fake.reclaimedRunIds.length === 2);
      expect(new Set(fake.reclaimedRunIds).size).toBe(2);
      const blocked = yield* service.start(request({ name: "evict-c" })).pipe(Effect.flip);
      expect(blocked).toBeInstanceOf(SubagentCapacityError);
      expect(blocked).toMatchObject({ limit: 12 });
      expect(fake.reclaimedRunIds).toHaveLength(2);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(startA)).state).toBe("running");
      expect((yield* Fiber.join(startB)).state).toBe("running");
      expect(yield* runViews(service)).toHaveLength(60);
    });
  });
});

describe("Pi model confirmation", () => {
  it.effect("fails a start when Pi selects a different model than the route requires", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      expect(
        yield* service.start(request({ model: "openai-codex/gpt-6-luna" })).pipe(Effect.flip),
      ).toMatchObject({ code: "pi_model_mismatch" });
      expect((yield* service.start(request({ model: "openai-codex/gpt-5.6-sol@1m" }))).state).toBe(
        "running",
      );
    });
  });

  it.effect("keeps the failure's own message, without stack frames, as the run's error", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failure = yield* service
        .start(request({ model: "openai-codex/gpt-6-luna" }))
        .pipe(Effect.flip);
      const [run] = yield* runViews(service);
      expect(run).toMatchObject({ state: "failed", error: failure.message });
      expect(run?.error).not.toMatch(/\n\s*at\s|node_modules|file:\/\//u);
    });
  });
});
