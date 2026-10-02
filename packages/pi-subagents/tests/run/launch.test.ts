// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentRunView } from "../../src/run/model.ts";
import { MAX_RETAINED_RUNS } from "../../src/run/limits.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  completeLocalRun,
  fakeChildLayer,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

/** Starts and completes `count` root runs whose children are `fake.controls[offset..]`. */
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
        const stale = yield* service.status(first.id).pipe(Effect.flip);
        return { second, stale };
      });

      expect(first.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(result.second.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(result.second.id).not.toBe(first.id);
      expect(result.stale).toMatchObject({ _tag: "SubagentNotFoundError", id: first.id });
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

  it.effect("rejects an unsupported backend before reserving or spawning a run", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failure = yield* Effect.flip(
        service.start(request({ host: "local", runtime: "claude" })),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_not_implemented",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    });
  });

  it.effect("injects profile guidance and retains selection provenance", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const started = yield* service.start(
        request({
          profile: "reviewer",
          profileGuidance: "Act as an independent reviewer.",
          selection: {
            source: "profile-parent-candidate",
            reason: "Profile reviewer explicitly fell back to the parent model.",
            skippedCandidates: [],
          },
        }),
      );
      expect(started).toMatchObject({
        profile: "reviewer",
        selection: { source: "profile-parent-candidate" },
      });
      expect(fake.controls[0]?.launch.systemPrompt).toContain("assigned profile is reviewer");
      expect(fake.controls[0]?.launch.systemPrompt).toContain("independent reviewer");
    });
  });

  it.effect("preserves selected fork context through run state and child launch", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const started = yield* service.start(
        request({ context: "fork", profile: "oracle", name: "forked-oracle" }),
      );
      expect(started.context).toBe("fork");
      expect(fake.controls[0]?.launch.context).toBe("fork");
    });
  });

  it.effect(
    "keeps soft-effort runs alive on a non-reasoning model and reports the effective level",
    () => {
      // Models the parent's Pi child resolving to a non-reasoning model whose effective level is off.
      const { layer } = localServiceFixture(
        {},
        fakeChildLayer(Effect.void, { stateThinkingLevel: "off" }),
      );
      return withService(layer, function* (service) {
        const started = yield* service.start(request({ effort: "high", effortWasExplicit: false }));
        expect(started).toMatchObject({ state: "running", effort: "off" });

        const failure = yield* Effect.flip(
          service.start(request({ effort: "high", effortWasExplicit: true })),
        );
        expect(failure).toMatchObject({
          _tag: "InvalidSubagentRequestError",
          code: "pi_effort_unsupported",
        });
        expect(failure.message).toContain(
          "does not support requested effort high; effective level was off",
        );
      });
    },
  );

  it.effect("maps an uncertain writer start prompt to start_outcome_uncertain", () => {
    const { layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialTransportFailures: [
          { spawnIndex: 0, type: "prompt", code: "transport_outcome_uncertain" },
        ],
      }),
    );
    return withService(layer, function* (service) {
      const failure = yield* service
        .start(request({ name: "uncertain-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        code: "start_outcome_uncertain",
      });
      expect(failure.message).toContain("The writer task may have been accepted");
      expect((yield* service.list)[0]?.state).toBe("failed");
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
        expect(activeSaturation).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
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
        expect(blockedDuringCleanup).toMatchObject({
          _tag: "SubagentCapacityError",
          limit: 12,
        });
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

  it.effect("retains bounded cleanup timeout while cleanup ownership holds capacity", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const gates = yield* Effect.all(Array.from({ length: 12 }, () => Deferred.make<void>()));
      const runs = [];
      for (let index = 0; index < 12; index += 1) {
        const run = yield* service.start(request({ name: `cleanup-${index + 1}` }));
        runs.push(run);
        fake.controls[index]?.gateRelease(gates[index]!);
        fake.controls[index]?.settle();
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs.find(
                (candidate) => candidate.id === run.id && candidate.state === "completed",
              ),
          ),
        );
      }
      expect(
        yield* service.start(request({ name: "capacity-probe" })).pipe(Effect.flip),
      ).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });

      const resuming = yield* service.resume(runs[0]!.id).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const timeout = yield* Fiber.join(resuming).pipe(Effect.flip);
      expect(timeout).toMatchObject({
        _tag: "SubagentProcessError",
        code: "cleanup_timeout",
      });
      yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined), {
        discard: true,
      });
    });
  });

  it.effect("does not turn unresolved history into a tree-wide admission budget", () => {
    let deliveryAttempts = 0;
    const { fake, layer } = localServiceFixture({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        deliveryAttempts += 1;
        return { deliveredCompletionKeys: [] };
      },
    });
    return withService(layer, function* (service) {
      const firstId = (yield* completeHistory(service, fake, 50, "retained"))[0]!;
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => deliveryAttempts === 1);
      const admitted = yield* service.start(request({ name: "admitted-with-outbox" }));
      expect(admitted.state).toBe("running");
      expect(yield* service.list).toHaveLength(51);

      expect((yield* service.status(firstId)).finalText).toBe("Report 1");
      expect(fake.reclaimedRunIds).toEqual([]);
      const recovered = yield* service.start(request({ name: "capacity-recovered" }));
      expect(recovered.state).toBe("running");
      const retained = yield* service.list;
      expect(retained).toHaveLength(51);
      expect(retained.some((run) => run.id === firstId)).toBe(false);
      expect(fake.reclaimedRunIds).toEqual([firstId]);
    });
  });

  it.effect(
    "refuses a scripted descendant writer without reclaiming or quarantining full history",
    () => {
      const { fake, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const scripted = yield* service.startScriptSessionOwned(request());
        const history = yield* completeHistory(service, fake, MAX_RETAINED_RUNS, "retained", 1);
        for (const id of history) yield* service.status(id);
        const before = yield* service.list;
        expect(
          yield* service
            .startSessionOwnedFrom(scripted.id, request({ writeIntent: "writer" }))
            .pipe(Effect.flip),
        ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
        expect(yield* service.list).toEqual(before);
        expect(fake.reclaimedRunIds).toEqual([]);
        // A normal start still reclaims the eligible leaf, proving history really was at capacity.
        yield* service.start(request({ name: "allowed-after-refusal" }));
        expect(fake.reclaimedRunIds).toEqual([history[0]]);
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
      expect(blocked).toMatchObject({
        _tag: "SubagentProcessError",
        code: "fixture_reclaim_failed",
      });
      // Reclaim failure admitted nothing, left no starting orphan, and kept the
      // uncertain candidate registered but quarantined against unsafe resume.
      const afterFailure = yield* service.list;
      const secondId = afterFailure[1]?.id ?? "";
      const thirdId = afterFailure[2]?.id ?? "";
      expect(afterFailure).toHaveLength(50);
      expect(afterFailure.find((run) => run.id === firstId)?.warning).toContain(
        "remains quarantined",
      );
      expect(afterFailure.some((run) => run.name === "blocked")).toBe(false);
      expect(fake.reclaimedRunIds).toEqual([firstId]);
      // The prospective admission reservation is released, but the uncertain
      // record stays quarantined; a retry selects the next safe candidate.
      const retried = yield* service.start(request({ name: "blocked-retry" })).pipe(Effect.flip);
      expect(retried).toMatchObject({ code: "fixture_reclaim_failed" });
      expect(fake.reclaimedRunIds).toEqual([firstId, secondId]);
      reclaimFails = false;
      const recovered = yield* service.start(request({ name: "recovered" }));
      expect(recovered.state).toBe("running");
      const retained = yield* service.list;
      expect(retained).toHaveLength(50);
      expect(retained.some((run) => run.id === firstId)).toBe(true);
      expect(retained.some((run) => run.id === secondId)).toBe(true);
      expect(retained.some((run) => run.id === thirdId)).toBe(false);
    });
  });

  it.effect(
    "quarantines reclaimed history when a writer-pool pause rejects phase-C admission",
    () => {
      let reclaimGate: Deferred.Deferred<void, never> | undefined;
      const fake = fakeChildLayer(Effect.void, {
        get reclaimGate() {
          return reclaimGate;
        },
      });
      const { projections, layer } = localServiceFixture({}, fake);
      return withService(layer, function* (service) {
        const activeWriter = yield* service.start(
          request({
            name: "phase-c-active-writer",
            writeIntent: "writer",
            writes: ["src/active.ts"],
          }),
        );
        const oldestId = (yield* completeHistory(service, fake, 50, "phase-c-history", 1))[0]!;
        yield* TestClock.adjust("100 millis");
        reclaimGate = yield* Deferred.make<void>();
        const prospective = yield* service
          .start(
            request({
              name: "phase-c-prospective-writer",
              writeIntent: "writer",
              writes: ["src/prospective.ts"],
            }),
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => fake.reclaimedRunIds.includes(oldestId));

        fake.controls[0]?.offer({
          type: "tool_execution_start",
          toolCallId: "phase-c-violation",
          toolName: "edit",
          args: { path: "src/outside.ts", edits: [] },
        });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((run) => run.id === activeWriter.id)?.state === "paused",
        );
        yield* Deferred.succeed(reclaimGate, undefined);
        const rejected = yield* Fiber.join(prospective).pipe(Effect.flip);
        expect(rejected).toMatchObject({ _tag: "SubagentWriterConflictError" });

        const oldest = (yield* service.list).find((run) => run.id === oldestId);
        expect(oldest).toMatchObject({
          state: "completed",
          warning: expect.stringContaining("remains quarantined"),
        });
        const resumeFailure = yield* service.resume(oldestId).pipe(Effect.flip);
        expect(resumeFailure).toMatchObject({ code: "resume_state_reclaimed" });
        expect((yield* service.list).some((run) => run.name === "phase-c-prospective-writer")).toBe(
          false,
        );
      });
    },
  );

  it.effect("concurrent evicting starts never claim the same reclaim candidate", () => {
    let gate: Deferred.Deferred<void, never> | undefined;
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
      // Each start claimed a distinct candidate and reserved one prospective
      // process slot while both destructive reclaims were in flight.
      expect(new Set(fake.reclaimedRunIds).size).toBe(2);
      const blocked = yield* service.start(request({ name: "evict-c" })).pipe(Effect.flip);
      expect(blocked).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
      expect(fake.reclaimedRunIds).toHaveLength(2);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(startA)).state).toBe("running");
      expect((yield* Fiber.join(startB)).state).toBe("running");
      expect(yield* service.list).toHaveLength(60);
    });
  });

  it.effect("rejects capacity before reclaiming resumable history", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const oldestId = (yield* completeHistory(service, fake, 38, "history"))[0]!;
      yield* TestClock.adjust("100 millis");
      for (let index = 0; index < 12; index += 1)
        yield* service.start(request({ name: `active-${index + 1}` }));
      const failure = yield* service.start(request({ name: "capacity-blocked" })).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
      const retained = yield* service.list;
      expect(retained).toHaveLength(50);
      expect(retained.some((run) => run.id === oldestId)).toBe(true);
      expect(retained.some((run) => run.name === "capacity-blocked")).toBe(false);
      expect(fake.reclaimedRunIds).not.toContain(oldestId);
    });
  });

  it.effect("retains only the newest 50 terminal records", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      let firstId = "";
      for (let index = 0; index < 51; index += 1) {
        const run = yield* service.start(request({ name: `history-${index}` }));
        if (index === 0) firstId = run.id;
        yield* service.stop(run.id);
      }
      const history = yield* service.list;
      expect(history).toHaveLength(50);
      expect(history.some((run) => run.id === firstId)).toBe(false);
    });
  });
});
