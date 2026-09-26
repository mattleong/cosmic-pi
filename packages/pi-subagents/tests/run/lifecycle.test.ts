// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  completeLocalRun,
  contactParentFrame,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  localServiceFixture,
  profileLayerFor,
  request,
  withService,
} from "./fixtures/service-harness.ts";

describe("SubagentService", () => {
  it.effect("checks current direct-parent capacity before completed respawn", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(),
      profileLayerFor({ version: 6, nesting: { maxDirectChildren: 2, maxDepth: 3 } }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      yield* completeLocalRun(service, fake.controls[0]!, run.id, "Done.");
      const parent = yield* service.start(request());
      const blocker = yield* service.start(request());
      const before = yield* service.status(run.id);
      expect(yield* service.resume(run.id).pipe(Effect.flip)).toMatchObject({
        code: "direct_child_capacity",
        limit: 2,
      });
      expect(yield* service.status(run.id)).toMatchObject({
        state: "completed",
        reportGeneration: before.reportGeneration,
      });
      expect(fake.controls).toHaveLength(3);
      yield* service.stop(blocker.id);
      yield* service.start(request({ parentRunId: parent.id }));
      expect((yield* service.resume(run.id)).state).toBe("running");
      expect(fake.controls).toHaveLength(5);
    });
  });

  it.effect("resumes an in-place paused process at its parent's capacity", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(),
      profileLayerFor({ version: 6, nesting: { maxDirectChildren: 1, maxDepth: 3 } }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      expect((yield* service.resume(run.id)).state).toBe("running");
      expect(fake.controls).toHaveLength(1);
    });
  });

  it.effect(
    "cancels preownership writer validation without waiting for its promise or holding the lock",
    () => {
      let gate = false;
      let entered = false;
      const pending = Promise.race<never>([]);
      const writerLayer = Layer.effect(
        WriterLeaseService,
        Effect.gen(function* () {
          const base = yield* WriterLeaseService;
          return {
            ...base,
            canonicalize: (cwd: string) =>
              gate
                ? Effect.promise(() => {
                    entered = true;
                    return pending;
                  })
                : base.canonicalize(cwd),
          };
        }),
      ).pipe(Layer.provide(fakeWriterLeaseLayer()));
      const { fake, layer } = localServiceFixture(
        {},
        fakeChildLayer(),
        profileLayerFor({}),
        writerLayer,
      );
      return withService(layer, function* (service) {
        const run = yield* service.start(request({ writeIntent: "writer" }));
        yield* completeLocalRun(service, fake.controls[0]!, run.id, "Done.");
        const before = yield* service.status(run.id);
        gate = true;
        const waiter = yield* service.resume(run.id).pipe(Effect.forkChild);
        yield* yieldUntil(() => entered);
        // Both must finish while the foreign Promise remains permanently unsettled.
        yield* service.rename(run.id, "lock-reused");
        yield* Fiber.interrupt(waiter);
        expect(yield* service.status(run.id)).toMatchObject({
          state: "completed",
          reportGeneration: before.reportGeneration,
        });
        expect(fake.controls).toHaveLength(1);
        gate = false;
        expect((yield* service.resume(run.id)).state).toBe("running");
        yield* service.stop(run.id);
      });
    },
  );

  it.effect("keeps a claimed resume owned after waiter cancellation", () =>
    Effect.gen(function* () {
      const spawnGate = yield* Deferred.make<void>();
      let gate = false;
      const { fake, projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(Effect.suspend(() => (gate ? Deferred.await(spawnGate) : Effect.void))),
      );
      yield* withService(layer, function* (service) {
        const run = yield* service.start(request({ writeIntent: "writer" }));
        yield* completeLocalRun(service, fake.controls[0]!, run.id, "Done.");
        gate = true;
        const waiter = yield* service.resume(run.id).pipe(Effect.forkChild);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(spawnGate, undefined);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
        expect(fake.controls).toHaveLength(2);
        yield* service.stop(run.id);
        expect(fake.controls[1]?.released()).toBe(1);
      });
    }),
  );

  for (const changed of [false, true]) {
    it.effect(
      `writer respawn ${changed ? "rejects changed" : "retains unchanged"} directory identity`,
      () => {
        let identity = "original-directory";
        const leases: string[] = [];
        const { fake, layer } = localServiceFixture(
          {},
          fakeChildLayer(),
          profileLayerFor({}),
          fakeWriterLeaseLayer({
            filesystemIdentity: () => identity,
            onAcquire: (lease) => leases.push(lease.filesystemIdentityDigest),
          }),
        );
        return withService(layer, function* (service) {
          const run = yield* service.start(request({ writeIntent: "writer" }));
          yield* completeLocalRun(service, fake.controls[0]!, run.id, "Done.");
          const before = yield* service.status(run.id);
          if (changed) identity = "replacement-directory";
          if (changed) {
            expect(yield* service.resume(run.id).pipe(Effect.flip)).toMatchObject({
              code: "writer_cwd_identity_changed",
            });
            expect(yield* service.status(run.id)).toMatchObject({
              state: before.state,
              reportGeneration: before.reportGeneration,
              endedAt: before.endedAt,
            });
            expect(fake.controls).toHaveLength(1);
            expect(leases).toHaveLength(1);
            identity = "original-directory";
          }
          expect((yield* service.resume(run.id)).state).toBe("running");
          expect(fake.controls).toHaveLength(2);
          expect(leases).toEqual([leases[0], leases[0]]);
        });
      },
    );
  }

  it.effect("starts a child, projects completion, and retains bounded result state", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const started = yield* service.start(request({ name: "auth-reader" }));
      expect(started).toMatchObject({
        name: "auth-reader",
        state: "running",
        model: "openai-codex/gpt-5.6-sol",
        sessionFile: "/tmp/child-session.jsonl",
      });
      expect(started.id).toMatch(/^agent-r[0-9a-z]+-1$/);

      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/auth.ts" },
      });
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "auth source" }] },
        isError: false,
      });
      fake.controls[0]?.offer({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Review complete." },
      });
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Review complete." }],
          usage: { input: 12, totalTokens: 12, cost: { total: 0.001 } },
        },
      });
      fake.controls[0]?.offer({ type: "turn_end" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 12);
      expect((yield* service.status(started.id)).finalText).toBeUndefined();

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const completed = yield* service.status(started.id);
      expect(completed.finalText).toBe("Review complete.");
      expect(completed.reportGeneration).toBe(1);
      expect(completed.usage.totalTokens).toBe(12);
      expect(completed.sessionEvents).toMatchObject([
        { type: "tool", toolName: "read", target: "src/auth.ts", state: "completed" },
        { type: "assistant", text: "Review complete." },
      ]);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      expect(fake.reclaimedRunIds).toEqual([]);
    });
  });

  it.effect("reclaims completed local Pi run state when the session scope ends", () =>
    Effect.gen(function* () {
      const { fake, layer } = localServiceFixture();

      const runId = yield* withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "session-reclaim" }));
        yield* completeLocalRun(service, fake.controls[0]!, run.id);
        expect(fake.reclaimedRunIds).toEqual([]);
        return run.id;
      });

      expect(fake.reclaimedRunIds).toEqual([runId]);
    }),
  );

  it.effect("quarantines a stopped run when private state reclamation fails", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { failReclaim: true }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "reclaim-failure" }));
      const stopped = yield* service.stop(run.id);
      expect(stopped.state).toBe("stopped");
      expect(stopped.warning).toContain("remains quarantined");
      expect(fake.reclaimedRunIds).toEqual([run.id]);
    });
  });

  it.effect("coalesces streamed token activity publications", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "streaming-reader" }));
      const beforeTokens = projections.length;
      for (let index = 0; index < 100; index += 1)
        fake.controls[0]?.offer({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: String(index) },
        });
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Still working." }],
          usage: { input: 1, totalTokens: 1 },
        },
      });
      fake.controls[0]?.offer({ type: "turn_end" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 1);
      expect(projections.length - beforeTokens).toBeLessThanOrEqual(2);

      yield* TestClock.adjust("1 second");
      const beforeActivityTick = projections.length;
      fake.controls[0]?.offer({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "next" },
      });
      yield* yieldUntil(() => projections.length === beforeActivityTick + 1);
      expect((yield* service.status(run.id)).lastActivityAt).toBe(run.lastActivityAt + 1_000);
    });
  });

  it.effect("terminates a completed Pi process and restores its saved session", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "terminate-and-resume" }));
      yield* completeLocalRun(service, fake.controls[0]!, run.id);
      const completed = yield* service.status(run.id);
      expect(completed.state).toBe("completed");
      expect(completed.reportGeneration).toBe(1);
      expect(completed.finalText).toBe("Assignment complete.");
      expect(completed.pid).toBeUndefined();
      expect(completed.sessionFile).toBe("/tmp/child-session.jsonl");

      yield* service.rename(run.id, "renamed-before-resume");
      const resumed = yield* service.resume(run.id, "Continue from disk.");
      expect(resumed.state).toBe("running");
      expect(resumed.finalText).toBeUndefined();
      expect(fake.controls).toHaveLength(2);
      expect(fake.controls[1]?.launch.name).toBe("renamed-before-resume");
      expect(fake.controls[1]?.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
    });
  });

  it.effect("reports a backend-generic error when completed resume state is unavailable", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { omitSessionFile: true }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "no-resume-token" }));
      yield* completeLocalRun(service, fake.controls[0]!, run.id);

      const failure = yield* service.resume(run.id).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_resume_unavailable",
      });
      expect(failure.message).toContain("local/pi did not provide continuation state");
      expect(failure.message).not.toContain("session file");
    });
  });

  it.effect("waits for completed-process cleanup before restoring the session", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const cleanupGate = yield* Deferred.make<void>();
      const run = yield* service.start(request({ name: "cleanup-race" }));
      fake.controls[0]?.gateRelease(cleanupGate);
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const resuming = yield* service
        .resume(run.id, "Continue after cleanup.")
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(fake.controls).toHaveLength(1);

      yield* Deferred.succeed(cleanupGate, undefined);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      expect((yield* Fiber.join(resuming)).state).toBe("running");
      expect(fake.controls).toHaveLength(2);
    });
  });

  it.effect("finalizes and releases slots when a backend awaitExit fails", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failedRun = yield* service.start(
        request({ name: "await-exit-failure", writeIntent: "writer" }),
      );
      fake.controls[0]?.failExit("Fixture awaitExit failure.");
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some((run) => run.id === failedRun.id && run.state === "failed") === true,
      );
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failed = yield* service.status(failedRun.id);
      expect(failed).toMatchObject({
        state: "failed",
        error: expect.stringContaining("Fixture awaitExit failure"),
      });
      expect(failed.pid).toBeUndefined();

      const replacement = yield* service.start(
        request({ name: "replacement-after-await-failure", writeIntent: "writer" }),
      );
      expect(replacement.state).toBe("running");
      expect(fake.controls).toHaveLength(2);
    });
  });

  it.effect("drains buffered lifecycle output before processing child exit", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "exit-drain" }));
      fake.controls[0]?.settle("Final output before exit.");
      fake.controls[0]?.exit(0);

      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const completed = yield* service.status(run.id);
      expect(completed.state).toBe("completed");
      expect(completed.finalText).toBe("Final output before exit.");
    });
  });

  it.effect("continues a session-owned launch after its waiter is interrupted", () =>
    Effect.gen(function* () {
      const spawnGate = yield* Deferred.make<void>();
      const { projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(Deferred.await(spawnGate)),
      );

      yield* withService(layer, function* (service) {
        const waiting = yield* service
          .startSessionOwned(request({ name: "cancelled-session-waiter" }))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        if (!id) return yield* Effect.die("session-owned launch id was not published");

        yield* Fiber.interrupt(waiting);
        yield* Deferred.succeed(spawnGate, undefined);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
        expect(yield* service.status(id)).toMatchObject({
          id,
          name: "cancelled-session-waiter",
          state: "running",
        });
      });
    }),
  );

  it.effect("settles interrupted startup as stopped without a warning", () => {
    const { fake, projections, notifications, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { dropInitialState: true }),
    );
    return withService(layer, function* (service) {
      const starting = yield* service
        .start(request({ name: "cancelled-start" }))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => fake.controls[0]?.sent("get_state") === true);
      yield* Fiber.interrupt(starting);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
      expect(notifications).toEqual([]);
      expect(fake.controls[0]?.released()).toBe(1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      expect((yield* service.status(id!)).error).toBeUndefined();
    });
  });

  it.effect("preserves terminal state, completion delivery, and local completed rename", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const completedRun = yield* service.start(request({ name: "completed-name" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const before = projections.at(-1)?.runs.find((run) => run.id === completedRun.id);

      const renamed = yield* service.rename(completedRun.id, "retained-name");
      expect(renamed).toMatchObject({ state: "completed", name: "retained-name" });
      expect(fake.controls[0]?.sent("set_session_name")).toBe(false);
      const stoppedCompleted = yield* service.stop(completedRun.id);
      expect(stoppedCompleted.state).toBe("completed");
      expect(stoppedCompleted.endedAt).toBe(before?.endedAt);

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.some((item) => item.type === "completed"));
      expect(notifications).toMatchObject([
        { type: "completed", runs: [{ id: completedRun.id, name: "retained-name" }] },
      ]);

      const failedRun = yield* service.start(request({ name: "failed-name" }));
      fake.controls[1]?.exit(1);
      yield* yieldUntil(() =>
        Boolean(
          projections.at(-1)?.runs.some((run) => run.id === failedRun.id && run.state === "failed"),
        ),
      );
      const failedBeforeStop = projections
        .at(-1)
        ?.runs.find((candidate) => candidate.id === failedRun.id);
      for (let attempt = 0; attempt < 5 && notifications.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust("100 millis");
      }
      expect(notifications.filter((item) => item.type === "completed")).toHaveLength(2);
      expect(notifications[1]).toMatchObject({
        type: "completed",
        runs: [
          {
            id: failedRun.id,
            name: "failed-name",
            generation: 1,
            outcome: "failed",
            error: expect.any(String),
          },
        ],
      });
      const stoppedFailed = yield* service.stop(failedRun.id);
      expect(stoppedFailed.state).toBe("failed");
      expect(stoppedFailed.endedAt).toBe(failedBeforeStop?.endedAt);
    });
  });

  it.effect("ignores child contact and lifecycle events after a run is terminal", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "terminal-reader" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      fake.controls[0]?.offerIpc(contactParentFrame("late-question", "question", "Too late?"));
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect((yield* service.status(run.id)).question).toBeUndefined();
    });
  });

  it.effect("keeps a run stopped when startup finishes late", () =>
    Effect.gen(function* () {
      const spawnGate = yield* Deferred.make<void>();
      const cleanupOrder: string[] = [];
      const { fake, projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(Deferred.await(spawnGate), {
          onRelease: () => cleanupOrder.push("backend"),
        }),
        profileLayerFor({}),
        fakeWriterLeaseLayer({ onRelease: () => cleanupOrder.push("lease") }),
      );

      yield* withService(layer, function* (service) {
        const starting = yield* service
          .start(request({ name: "slow-start", writeIntent: "writer" }))
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        const stopping = yield* service.stop(id!).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(projections.at(-1)?.runs[0]?.state).toBe("stopping");
        yield* Deferred.succeed(spawnGate, undefined);
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        yield* Fiber.await(starting);
        expect((yield* service.status(id!)).state).toBe("stopped");
        expect(fake.reclaimedRunIds).toContain(id);
        expect(cleanupOrder).toEqual(["backend", "lease"]);
      });
    }),
  );

  it.effect("terminates a child after malformed known protocol input", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      yield* service.start(request({ name: "bad-protocol" }));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.terminations).toContain("force");
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.list)[0]?.state).toBe("failed");
    });
  });

  it.effect("keeps a failed resume terminal and redacts the RPC error", () => {
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialFailures: [{ spawnIndex: 1, type: "prompt", error: "token=secret-value" }],
      }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "resume-failure" }));
      fake.controls[0]?.settle("Preserved report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const failure = yield* Effect.flip(service.resume(run.id, "Continue"));
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain("secret-value");
      const failed = yield* service.status(run.id);
      expect(failed.state).toBe("failed");
      expect(failed.finalText).toBe("Preserved report.");
      expect(fake.controls[1]?.terminations).toContain("force");
    });
  });

  it.effect("silently releases children when the session runtime is replaced", () => {
    const { fake, notifications, layer } = localServiceFixture();
    return Effect.gen(function* () {
      yield* withService(layer, function* (service) {
        yield* service.start(request());
      });

      expect(fake.controls[0]?.released()).toBe(1);
      expect(notifications).toEqual([]);
    });
  });
});
