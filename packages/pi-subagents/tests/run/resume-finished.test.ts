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
  runView,
  runViews,
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
    expect((yield* runView(service, run.id)).state).toBe("failed");
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
      expect(yield* runView(service, run.id)).toMatchObject({ state: "completed" });
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
      expect(yield* runView(service, run.id)).toMatchObject({ state: "completed" });
    });
  });

  it.effect("refuses a failed run without continuation state", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialFailures: [{ spawnIndex: 0, type: "get_state", error: "No session state." }],
      }),
    );
    return withService(layer, function* (service) {
      yield* service.start(request()).pipe(Effect.flip);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failed = (yield* runViews(service))[0]!;
      expect(failed.state).toBe("failed");
      const refusal = yield* service.resume(failed.id).pipe(Effect.flip);
      expect(refusal).toMatchObject({ code: "backend_resume_unavailable" });
      expect(fake.controls).toHaveLength(1);
      expect((yield* runView(service, failed.id)).state).toBe("failed");
    });
  });
});
