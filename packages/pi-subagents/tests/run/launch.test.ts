// Explicit test entry-point Layer provision owns each scoped service runtime.
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentProjection, SubagentRunView } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import { fakeChildLayer, request, serviceLayer } from "./fixtures/service-harness.ts";

describe("SubagentService", () => {
  it.effect("namespaces run IDs across runtime replacement and rejects stale IDs", () =>
    Effect.gen(function* () {
      const firstFake = fakeChildLayer();
      const firstLayer = serviceLayer().pipe(Layer.provide(firstFake.layer));
      const first = yield* SubagentService.use((service) => service.start(request())).pipe(
        Effect.scoped,
        Effect.provide(firstLayer),
      );

      const secondFake = fakeChildLayer();
      const secondLayer = serviceLayer().pipe(Layer.provide(secondFake.layer));
      const result = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const second = yield* service.start(request());
        const stale = yield* service.status(first.id).pipe(Effect.flip);
        return { second, stale };
      }).pipe(Effect.scoped, Effect.provide(secondLayer));

      expect(first.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(result.second.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(result.second.id).not.toBe(first.id);
      expect(result.stale).toMatchObject({ _tag: "SubagentNotFoundError", id: first.id });
    }),
  );

  it.effect("allocates concurrent unnamed IDs, ordinals, and fallback names atomically", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects an unsupported backend before reserving or spawning a run", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* Effect.flip(
        service.start(request({ host: "herdr", runtime: "claude" })),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_not_implemented",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("injects profile guidance and retains selection provenance", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("preserves selected fork context through run state and child launch", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const started = yield* service.start(
        request({ context: "fork", profile: "oracle", name: "forked-oracle" }),
      );
      expect(started.context).toBe("fork");
      expect(fake.controls[0]?.launch.context).toBe("fork");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "keeps soft-effort runs alive on a non-reasoning model and reports the effective level",
    () => {
      // Models the parent's Pi child resolving to a non-reasoning model whose effective level is off.
      const fake = fakeChildLayer(Effect.void, { stateThinkingLevel: "off" });
      const layer = serviceLayer().pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const started = yield* service.start(request({ effort: "high", effortWasExplicit: false }));
        expect(started).toMatchObject({ state: "running", effort: "off" });

        const failure = yield* Effect.flip(
          service.start(request({ effort: "high", effortWasExplicit: true })),
        );
        expect(failure._tag).toBe("InvalidSubagentRequestError");
        expect(failure.message).toContain(
          "does not support requested effort high; effective level was off",
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("maps an uncertain writer start prompt to start_outcome_uncertain", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialTransportFailures: [
        { spawnIndex: 0, type: "prompt", code: "transport_outcome_uncertain" },
      ],
    });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "uncertain-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        code: "start_outcome_uncertain",
      });
      expect(failure.message).toContain("The writer task may have been accepted");
      expect((yield* service.list)[0]?.state).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails an explicit-effort start when the backend resolves another effort", () => {
    const fake = fakeChildLayer(Effect.void, { stateThinkingLevel: "medium" });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "effort-mismatch", effort: "high", effortWasExplicit: true }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "pi_effort_unsupported",
      });
      expect(failure.message).toContain("does not support requested effort high");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "enforces active and cleanup-owned capacity before admitting work after release",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
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
        fake.controls[0]?.offer({ type: "agent_settled" });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs.some(
                (candidate) => candidate.id === runs[0]?.id && candidate.state === "completed",
              ),
          ),
        );
        const cleanupSaturation = yield* service
          .start(request({ name: "thirteenth-cleanup" }))
          .pipe(Effect.flip);
        expect(cleanupSaturation).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
        expect(cleanupSaturation.message).toContain("finish cleanup");
        expect(fake.controls).toHaveLength(12);

        yield* Deferred.succeed(cleanupGate, undefined);
        yield* yieldUntil(() => fake.controls[0]?.released() === 1);
        const admitted = yield* service.start(request({ name: "admitted-after-cleanup" }));
        expect(admitted.state).toBe("running");
        expect(fake.controls).toHaveLength(13);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("distinguishes cleanup-owned capacity saturation and bounded cleanup timeout", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const gates = yield* Effect.all(Array.from({ length: 12 }, () => Deferred.make<void>()));
      const runs = [];
      for (let index = 0; index < 12; index += 1) {
        const run = yield* service.start(request({ name: `cleanup-${index + 1}` }));
        runs.push(run);
        fake.controls[index]?.gateRelease(gates[index]!);
        fake.controls[index]?.offer({ type: "agent_settled" });
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
      const saturated = yield* service.start(request({ name: "capacity-probe" })).pipe(Effect.flip);
      expect(saturated).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
      expect(saturated.message).toContain("finish cleanup");

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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("bounds failed-delivery history at 50 and recovers admission after consumption", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let deliveryAttempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        deliveryAttempts += 1;
        return { deliveredCompletionKeys: [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let firstId = "";
      for (let index = 0; index < 50; index += 1) {
        const run = yield* service.start(request({ name: `retained-${index + 1}` }));
        if (index === 0) firstId = run.id;
        fake.controls[index]?.offer({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Report ${index + 1}` }],
          },
        });
        fake.controls[index]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "completed",
        );
        yield* yieldUntil(() => fake.controls[index]?.released() === 1);
      }
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => deliveryAttempts === 1);
      const capacity = yield* service
        .start(request({ name: "capacity-rejected" }))
        .pipe(Effect.flip);
      expect(capacity).toMatchObject({
        _tag: "SubagentHistoryCapacityError",
        code: "history_outbox_capacity",
        limit: 50,
      });
      expect(yield* service.list).toHaveLength(50);

      expect((yield* service.status(firstId)).finalText).toBe("Report 1");
      expect(fake.reclaimedRunIds).toEqual([]);
      const recovered = yield* service.start(request({ name: "capacity-recovered" }));
      expect(recovered.state).toBe("running");
      const retained = yield* service.list;
      expect(retained).toHaveLength(50);
      expect(retained.some((run) => run.id === firstId)).toBe(false);
      expect(fake.reclaimedRunIds).toEqual([firstId]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps the evicted record registered and admits nothing when reclaim fails", () => {
    let reclaimFails = true;
    const fake = fakeChildLayer(Effect.void, {
      get failReclaim() {
        return reclaimFails;
      },
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) =>
        notification.type === "completed"
          ? {
              deliveredCompletionKeys: notification.runs.map(
                (run) => `${run.id}:${run.generation}`,
              ),
            }
          : undefined,
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let firstId = "";
      for (let index = 0; index < 50; index += 1) {
        const run = yield* service.start(request({ name: `evictable-${index + 1}` }));
        if (index === 0) firstId = run.id;
        fake.controls[index]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "completed",
        );
        yield* yieldUntil(() => fake.controls[index]?.released() === 1);
      }
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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("concurrent evicting starts never claim the same reclaim candidate", () => {
    let gate: Deferred.Deferred<void, never> | undefined;
    const fake = fakeChildLayer(Effect.void, {
      get reclaimGate() {
        return gate;
      },
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) =>
        notification.type === "completed"
          ? {
              deliveredCompletionKeys: notification.runs.map(
                (run) => `${run.id}:${run.generation}`,
              ),
            }
          : undefined,
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      for (let index = 0; index < 40; index += 1) {
        const run = yield* service.start(request({ name: `candidate-${index + 1}` }));
        fake.controls[index]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "completed",
        );
        yield* yieldUntil(() => fake.controls[index]?.released() === 1);
      }
      yield* TestClock.adjust("100 millis");
      for (let index = 0; index < 10; index += 1)
        yield* service.start(request({ name: `active-before-eviction-${index + 1}` }));
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
      expect(yield* service.list).toHaveLength(50);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects capacity before reclaiming resumable history", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) =>
        notification.type === "completed"
          ? {
              deliveredCompletionKeys: notification.runs.map(
                (run) => `${run.id}:${run.generation}`,
              ),
            }
          : undefined,
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let oldestId = "";
      for (let index = 0; index < 38; index += 1) {
        const run = yield* service.start(request({ name: `history-${index + 1}` }));
        if (index === 0) oldestId = run.id;
        fake.controls[index]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "completed",
        );
        yield* yieldUntil(() => fake.controls[index]?.released() === 1);
      }
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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retains only the newest 50 terminal records", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let firstId = "";
      for (let index = 0; index < 51; index += 1) {
        const run = yield* service.start(request({ name: `history-${index}` }));
        if (index === 0) firstId = run.id;
        yield* service.stop(run.id);
      }
      const history = yield* service.list;
      expect(history).toHaveLength(50);
      expect(history.some((run) => run.id === firstId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
