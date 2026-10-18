import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { yieldUntil } from "pi-cosmic-core/testing";
import { SubagentWriterConflictError } from "../../src/run/errors.ts";
import type { SubagentCleanupDiagnostic, SubagentProjection } from "../../src/run/model.ts";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

const originalFailure: SubagentCleanupDiagnostic = {
  phase: "process-group",
  code: "group_observation_failed",
  message: "The original process group could not be observed absent (EPERM).",
};
const latest = (projections: ReadonlyArray<SubagentProjection>, id: string) =>
  projections.at(-1)?.runs.find((run) => run.id === id);
const child = (fake: ReturnType<typeof fakeChildLayer>, index = 0) => {
  const control = fake.controls[index];
  if (!control) throw new Error("Expected acquired fake child.");
  return control;
};
const writer = (name: string, path: string) =>
  request({ name, task: `Edit ${path}`, writeIntent: "writer" });

describe("explicit cleanup verification", () => {
  it.effect("singleflights concurrent stops after one waiter is cancelled", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { fake, projections, layer } = localServiceFixture();
      yield* withService(layer, function* (service) {
        const run = yield* service.start(request());
        const control = child(fake, 0);
        control.cleanup.fail(originalFailure);
        control.settle("Final report.");
        yield* yieldUntil(
          () => latest(projections, run.id)?.cleanup?.disposition === "quarantined",
        );
        control.cleanup.gate(gate);
        const first = yield* service.stop(run.id).pipe(Effect.forkScoped);
        yield* yieldUntil(() => control.cleanup.verifications() === 1);
        expect(latest(projections, run.id)?.cleanup).toMatchObject({
          disposition: "pending",
          diagnostic: originalFailure,
        });
        const second = yield* service.stop(run.id).pipe(Effect.forkScoped);
        yield* Fiber.interrupt(first);
        expect(control.cleanup.verifications()).toBe(1);
        control.cleanup.confirm();
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Fiber.join(second)).cleanup?.disposition).toBe("confirmed");
        expect(control.cleanup.verifications()).toBe(1);
        expect(control.released()).toBe(1);
        expect((yield* service.stop(run.id)).state).toBe("completed");
      });
    }),
  );

  it.effect(
    "recovers each quarantined pool member independently while an active peer retains the lease",
    () => {
      const counts = leaseCounts();
      const { fake, projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(),
        undefined,
        fakeWriterLeaseLayer({ counts }),
      );
      return withService(layer, function* (service) {
        const first = yield* service.start(writer("first", "src/a.ts"));
        const second = yield* service.start(writer("second", "src/b.ts"));
        const active = yield* service.start(writer("active", "src/c.ts"));
        for (const control of fake.controls.slice(0, 2)) {
          control.cleanup.fail(originalFailure);
          control.settle();
        }
        yield* yieldUntil(() =>
          [first, second].every(
            (run) => latest(projections, run.id)?.cleanup?.disposition === "quarantined",
          ),
        );
        expect(latest(projections, active.id)?.writerCleanupQuarantined).toBe(true);
        expect(counts.release).toBe(0);
        child(fake, 0).cleanup.confirm();
        expect((yield* service.stop(first.id)).cleanup?.disposition).toBe("confirmed");
        expect(latest(projections, second.id)?.writerCleanupQuarantined).toBe(true);
        expect(latest(projections, active.id)?.writerCleanupQuarantined).toBe(true);
        expect(
          yield* service.start(writer("blocked", "src/d.ts")).pipe(Effect.flip),
        ).toBeInstanceOf(SubagentWriterConflictError);
        child(fake, 1).cleanup.confirm();
        yield* service.stop(second.id);
        expect(latest(projections, active.id)?.writerCleanupQuarantined).toBeUndefined();
        const admitted = yield* service.start(writer("admitted", "src/d.ts"));
        expect(counts.acquire).toBe(1);
        expect(counts.release).toBe(0);
        yield* service.stop(admitted.id);
        yield* service.stop(active.id);
        expect(counts.release).toBe(1);
        expect(fake.controls.slice(0, 2).map((control) => control.released())).toEqual([1, 1]);
      });
    },
  );

  it.effect(
    "never retries an uncertain writer lease commit after successful process verification",
    () => {
      const counts = leaseCounts();
      const { fake, projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(),
        undefined,
        fakeWriterLeaseLayer({ counts, failRelease: true }),
      );
      return withService(layer, function* (service) {
        const run = yield* service.start(writer("lease-uncertain", "src/a.ts"));
        const control = child(fake, 0);
        control.cleanup.fail(originalFailure);
        control.settle();
        yield* yieldUntil(
          () => latest(projections, run.id)?.cleanup?.disposition === "quarantined",
        );
        control.cleanup.confirm();
        const failedRelease = yield* service.stop(run.id);
        expect(failedRelease.cleanup).toMatchObject({
          disposition: "quarantined",
          recovery: "manual",
          diagnostic: { phase: "writer-lease" },
        });
        expect(counts.release).toBe(1);
        expect((yield* service.stop(run.id)).cleanup).toEqual(failedRelease.cleanup);
        expect(counts.release).toBe(1);
        expect(control.cleanup.verifications()).toBe(1);
      });
    },
  );

  it.effect("bounds and redacts retained and logged cleanup diagnostics", () => {
    const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
    const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)));
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      child(fake, 0).cleanup.fail({
        phase: "process-group",
        code: `Bearer private-token ${"c".repeat(120)}`,
        message: `Authorization: Bearer private-token\napi_key=private-key\n${"detail ".repeat(300)}`,
      });
      const failed = yield* service.stop(run.id);
      const diagnostic = failed.cleanup?.diagnostic;
      expect(diagnostic?.message.length).toBeLessThanOrEqual(1024);
      expect(diagnostic?.code?.length).toBeLessThanOrEqual(80);
      expect(JSON.stringify(diagnostic)).not.toContain("private-token");
      expect(JSON.stringify(diagnostic)).not.toContain("private-key");
      expect(failed.cleanup?.diagnostic?.phase).toBe("process-group");
      const cleanupLog = logs.find((entry) => entry.annotations.cleanupPhase === "process-group");
      expect(cleanupLog?.annotations.cleanupReason).toBe(diagnostic?.message);
      expect(JSON.stringify(logs)).not.toContain("private-token");
      expect(JSON.stringify(logs)).not.toContain("private-key");
    }).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  });
});
