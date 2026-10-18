import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  completeLocalRun,
  fakeChildLayer,
  localServiceFixture,
  request,
  reviewerContinuation,
  withService,
} from "./fixtures/service-harness.ts";

const failedReviewer = (
  service: SubagentServiceContract,
  fake: ReturnType<typeof fakeChildLayer>,
) =>
  Effect.gen(function* () {
    const run = yield* service.start(
      request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }),
    );
    const control = fake.controls.at(-1)!;
    control.exit(1);
    yield* yieldUntil(() => control.released() === 1);
    expect((yield* service.status(run.id)).state).toBe("failed");
    return run;
  });

describe("resuming finished runs", () => {
  it.effect("continues a failed Pi run in its own session", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* failedReviewer(service, fake);
      const resumed = yield* service.resume(run.id, "The provider recovered; continue.");
      expect(resumed).toMatchObject({ id: run.id, state: "running", assignmentEpoch: 2 });
      expect(resumed.error).toBeUndefined();
      expect(fake.controls).toHaveLength(2);
      expect(fake.controls[1]!.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
      yield* completeLocalRun(service, fake.controls[1]!, run.id, "Recovered report.");
      expect(yield* service.status(run.id)).toMatchObject({ state: "completed" });
    });
  });

  it.effect("continues a run the parent stopped once its cleanup is confirmed", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      expect((yield* service.stop(run.id)).state).toBe("stopped");
      yield* yieldUntil(() => fake.controls[0]!.released() === 1);
      expect((yield* service.resume(run.id, "Pick the task back up.")).state).toBe("running");
      expect(fake.controls[1]!.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
      // A stop no longer marks the resumed run inactive: its next report settles normally.
      yield* completeLocalRun(service, fake.controls[1]!, run.id, "Finished after the stop.");
      expect(yield* service.status(run.id)).toMatchObject({ state: "completed" });
    });
  });

  it.effect("refuses a failed run without continuation state and points to retry", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialFailures: [{ spawnIndex: 0, type: "get_state", error: "No session state." }],
      }),
    );
    return withService(layer, function* (service) {
      yield* service
        .start(request({ profile: "reviewer", routeContinuation: reviewerContinuation(0) }))
        .pipe(Effect.flip);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failed = (yield* service.list)[0]!;
      expect(failed.state).toBe("failed");
      const refusal = yield* service.resume(failed.id).pipe(Effect.flip);
      expect(refusal).toMatchObject({ code: "backend_resume_unavailable" });
      expect(refusal.message).toContain(`action: "retry"`);
      expect(fake.controls).toHaveLength(1);
      expect((yield* service.status(failed.id)).state).toBe("failed");
    });
  });

  it.effect("refuses a run whose retry is claimed or already superseded it", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failed = yield* failedReviewer(service, fake);
      const claim = yield* service.claimRetryContinuation(failed.id);
      expect(yield* service.resume(failed.id).pipe(Effect.flip)).toMatchObject({
        code: "resume_retry_claimed",
      });
      const successor = yield* service.startRetrySessionOwned({
        ...request({ profile: "reviewer", routeContinuation: reviewerContinuation(1) }),
        supersedes: { runId: failed.id, claimToken: claim.claimToken },
      });
      expect(yield* service.resume(failed.id).pipe(Effect.flip)).toMatchObject({
        code: "resume_superseded",
      });
      expect((yield* service.status(failed.id)).state).toBe("failed");
      expect((yield* service.status(successor.id)).state).toBe("running");
      expect(fake.controls).toHaveLength(2);
    });
  });

  it.effect("refuses retry while a resumed failed run is active", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failed = yield* failedReviewer(service, fake);
      yield* service.resume(failed.id, "Try once more.");
      expect(yield* service.claimRetryContinuation(failed.id).pipe(Effect.flip)).toMatchObject({
        code: "retry_source_not_failed",
      });
      fake.controls[1]!.exit(1);
      yield* yieldUntil(() => fake.controls[1]!.released() === 1);
      expect((yield* service.status(failed.id)).state).toBe("failed");
      // The resumed assignment may differ from the launch task, so it is never replayed.
      expect(yield* service.claimRetryContinuation(failed.id).pipe(Effect.flip)).toMatchObject({
        code: "retry_assignment_not_initial",
      });
    });
  });
});
