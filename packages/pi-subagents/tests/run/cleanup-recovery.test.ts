import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import { recordCleanup } from "../../src/run/record-cleanup.ts";
import { boundedCleanupDiagnostic } from "../../src/run/cleanup-diagnostic.ts";
import { backendHandleFixture, makeRunContext, runRecordFixture } from "./fixtures/run-context.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import { yieldUntil } from "pi-cosmic-core/testing";
import { SubagentWriterConflictError } from "../../src/run/errors.ts";
import type { SubagentCleanupDiagnostic, SubagentProjection } from "../../src/run/model.ts";
import {
  contactParentFrame,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  request,
  reviewerContinuation,
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
  request({ name, writeIntent: "writer", writes: [path] });

describe("explicit cleanup verification", () => {
  it("keeps stripped diagnostic text nonblank and omits stripped codes", () => {
    const diagnostic = boundedCleanupDiagnostic({
      phase: "backend-scope",
      code: "\u001b[0m ",
      message: "\u0000\u001b[0m ",
    });
    expect(diagnostic.code).toBeUndefined();
    expect(diagnostic.message.trim().length).toBeGreaterThan(0);
  });

  it.effect(
    "keeps reports and independent warnings through failed verification and confirmed recovery",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request());
        const control = child(fake, 0);
        control.offerIpc(
          contactParentFrame("child-warning", "warning", "Review the generated migration."),
        );
        yield* yieldUntil(() => latest(projections, run.id)?.warningSource === "child");
        control.failTransportNext("steer", "transport_outcome_uncertain");
        yield* service.send(run.id, "Check compatibility").pipe(Effect.flip);
        control.cleanup.fail(originalFailure);
        control.settle("Implementation report retained.");
        yield* yieldUntil(
          () => latest(projections, run.id)?.cleanup?.disposition === "quarantined",
        );
        const before = yield* service.status(run.id);
        expect(before).toMatchObject({
          state: "completed",
          cleanup: { recovery: "stop", diagnostic: originalFailure },
        });
        expect(before.systemWarning).toBeDefined();
        expect(
          before.sessionEvents.some(
            (event) => event.type === "notice" && event.text.includes("migration"),
          ),
        ).toBe(true);

        const stillQuarantined = yield* service.stop(run.id);
        expect(stillQuarantined.cleanup).toEqual(before.cleanup);
        expect(control.released()).toBe(1);
        control.cleanup.confirm();
        const recovered = yield* service.stop(run.id);
        expect(recovered.cleanup).toEqual({ disposition: "confirmed" });
        expect(recovered).toMatchObject({
          state: "completed",
          finalText: before.finalText,
          reportGeneration: before.reportGeneration,
          warning: before.warning,
          warningSource: before.warningSource,
          systemWarning: before.systemWarning,
        });
        expect(recovered.sessionEvents).toEqual(before.sessionEvents);
        expect(control.released()).toBe(1);
        expect(control.terminations).toEqual([]);
      });
    },
  );

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

  it.effect("does not clear a coexisting claim containment pause when cleanup recovers", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const offender = yield* service.start(writer("offender", "src/a.ts"));
      const quarantined = yield* service.start(writer("quarantined", "src/b.ts"));
      child(fake, 0).offer({
        type: "tool_execution_start",
        toolCallId: "outside-claim",
        toolName: "edit",
        args: { path: "src/b.ts", edits: [] },
      });
      yield* yieldUntil(() => latest(projections, offender.id)?.state === "paused");
      child(fake, 1).cleanup.fail(originalFailure);
      child(fake, 1).settle();
      yield* yieldUntil(
        () => latest(projections, quarantined.id)?.cleanup?.disposition === "quarantined",
      );
      expect(latest(projections, offender.id)).toMatchObject({
        writeAdmissionPaused: true,
        writeViolationOffender: true,
        writerCleanupQuarantined: true,
      });
      child(fake, 1).cleanup.confirm();
      yield* service.stop(quarantined.id);
      expect(latest(projections, offender.id)).toMatchObject({
        writeAdmissionPaused: true,
        writeViolationOffender: true,
      });
      expect(latest(projections, offender.id)?.writerCleanupQuarantined).toBeUndefined();
      expect(yield* service.start(writer("blocked", "src/c.ts")).pipe(Effect.flip)).toBeInstanceOf(
        SubagentWriterConflictError,
      );
      yield* service.resumeWriterAdmission(offender.id);
      expect((yield* service.start(writer("admitted", "src/c.ts"))).state).toBe("running");
    });
  });

  for (const scenario of ["mixed", "incomplete snapshot", "unknown"] as const)
    it.effect(`keeps ${scenario} cleanup failures manual and does not replay closed scopes`, () => {
      const { fake, layer } = localServiceFixture(
        {},
        fakeChildLayer(Effect.void, { releaseDefect: scenario === "unknown" }),
      );
      return withService(layer, function* (service) {
        const run = yield* service.start(writer("manual", "src/a.ts"));
        const control = child(fake, 0);
        if (scenario !== "unknown")
          control.cleanup.fail(
            originalFailure,
            scenario !== "incomplete snapshot",
            scenario === "mixed",
          );
        const stopped = yield* service.stop(run.id);
        expect(stopped.cleanup).toMatchObject({ disposition: "quarantined", recovery: "manual" });
        control.cleanup.confirm();
        expect((yield* service.stop(run.id)).cleanup).toEqual(stopped.cleanup);
        expect(control.cleanup.verifications()).toBe(0);
        expect(control.released()).toBe(1);
      });
    });

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

  it.effect(
    "allows explicit route retry after cleanup proof without clearing independent retry blockers",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(
          request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
        );
        const control = child(fake, 0);
        control.cleanup.fail(originalFailure);
        control.exit(1);
        yield* yieldUntil(
          () => latest(projections, run.id)?.cleanup?.disposition === "quarantined",
        );
        expect(yield* service.claimRetryContinuation(run.id).pipe(Effect.flip)).toMatchObject({
          code: "retry_cleanup_unconfirmed",
        });
        control.cleanup.confirm();
        const recovered = yield* service.stop(run.id);
        expect(recovered.state).toBe("failed");
        expect(recovered.retryBlocked).not.toBe(true);
        expect((yield* service.claimRetryContinuation(run.id)).source.id).toBe(run.id);
      });
    },
  );

  it.effect("retains completion claims across cleanup verification", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const control = child(fake);
      control.cleanup.fail(originalFailure);
      control.settle("Accepted report.");
      yield* yieldUntil(() => latest(projections, run.id)?.cleanup?.disposition === "quarantined");
      yield* service.withStatusObservations([run.id], ({ observations }) =>
        Effect.gen(function* () {
          const receipt = observations[0]?.completionReceipt;
          if (!receipt) return yield* Effect.die("Missing accepted completion claim.");
          control.cleanup.confirm();
          yield* service.stop(run.id);
          yield* service.consumeCompletions([receipt]);
          return undefined;
        }),
      );
      expect((yield* service.status(run.id)).reportStatus).toBe("delivered");
    });
  });

  it.effect("preserves an unrelated retry block while cleanup recovers", () =>
    Effect.gen(function* () {
      const record = yield* runRecordFixture();
      record.view = { ...record.view, state: "failed", retryBlocked: true };
      const failure = new Error("Owned process cleanup was not confirmed.");
      record.process = yield* backendHandleFixture({
        cleanupVerifier: {
          canVerify: () => true,
          diagnostic: (reason) =>
            Cause.isDieReason(reason) && reason.defect === failure ? originalFailure : undefined,
          verify: Effect.void,
        },
      });
      yield* Effect.addFinalizer(() => Effect.die(failure)).pipe(
        Effect.provideService(Scope.Scope, record.scope),
      );
      const cleanup = recordCleanup(yield* makeRunContext());
      yield* cleanup.closeRecordScope(record);
      expect(record.view.cleanup?.recovery).toBe("stop");
      yield* cleanup.verifyCleanup(record);
      expect(record.view.cleanup?.disposition).toBe("confirmed");
      expect(record.view.retryBlocked).toBe(true);
    }),
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
