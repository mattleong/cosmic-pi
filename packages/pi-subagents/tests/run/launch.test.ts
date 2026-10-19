import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentRunView } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { isSupervisorRunId } from "../../src/supervisor/protocol.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  completeLocalRun,
  fakeChildLayer,
  localServiceFixture,
  request,
  runView,
  runViews,
  withService,
} from "./fixtures/service-harness.ts";
import {
  SubagentNotFoundError,
  SubagentCapacityError,
  SubagentProcessError,
} from "../../src/run/errors.ts";

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

describe("SubagentService", () => {
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

      expect(isSupervisorRunId(first.id)).toBe(true);
      expect(isSupervisorRunId(result.second.id)).toBe(true);
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
      expect(new Set(runs.map((run) => run.id)).size).toBe(12);
      expect(new Set(runs.map((run) => run.name)).size).toBe(12);
      for (const run of runs) {
        const ordinal = run.id.slice(run.id.lastIndexOf("-") + 1);
        expect(run.name).toBe(`subagent-${ordinal}`);
      }
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
          Boolean(
            projections
              .at(-1)
              ?.runs.some(
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
      expect(afterFailure.find((run) => run.id === firstId)?.cleanup).toMatchObject({
        disposition: "quarantined",
        recovery: "manual",
        diagnostic: { phase: "backend-scope", code: "fixture_reclaim_failed" },
      });
      expect(afterFailure.some((run) => run.name === "blocked")).toBe(false);
      expect(fake.reclaimedRunIds).toEqual([firstId]);
      const retried = yield* service.start(request({ name: "blocked-retry" })).pipe(Effect.flip);
      expect(retried).toMatchObject({ code: "fixture_reclaim_failed" });
      expect(fake.reclaimedRunIds).toEqual([firstId, secondId]);
      reclaimFails = false;
      const recovered = yield* service.start(request({ name: "recovered" }));
      expect(recovered.state).toBe("running");
      const retained = yield* runViews(service);
      expect(retained).toHaveLength(50);
      expect(retained.some((run) => run.id === firstId)).toBe(true);
      expect(retained.some((run) => run.id === secondId)).toBe(true);
      expect(retained.some((run) => run.id === thirdId)).toBe(false);
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
});
