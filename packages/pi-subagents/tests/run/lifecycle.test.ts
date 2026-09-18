// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  profileLayerFor,
  request,
  serviceLayer,
  contactParentFrame,
  localServiceFixture,
} from "./fixtures/service-harness.ts";

describe("SubagentService", () => {
  it.effect("starts a child, projects completion, and retains bounded result state", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const started = yield* service.start(request({ name: "auth-reader" }));
      expect(started).toMatchObject({
        name: "auth-reader",
        state: "running",
        model: "openai-codex/gpt-5.6-sol",
        sessionFile: "/tmp/child-session.jsonl",
      });
      expect(started.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(fake.controls[0]?.commands.map((command) => command.type)).toEqual([
        "get_state",
        "prompt",
      ]);

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
          usage: { totalTokens: 12, cost: { total: 0.001 } },
        },
      });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("reclaims completed local Pi run state when the session scope ends", () =>
    Effect.gen(function* () {
      const { fake, projections, layer } = localServiceFixture();

      const runId = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ name: "session-reclaim" }));
        fake.controls[0]?.offer({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Assignment complete." }],
          },
        });
        fake.controls[0]?.offer({ type: "agent_settled" });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        yield* yieldUntil(() => fake.controls[0]?.released() === 1);
        expect(fake.reclaimedRunIds).toEqual([]);
        return run.id;
      }).pipe(Effect.scoped, provideBuiltLayer(layer));

      expect(fake.reclaimedRunIds).toEqual([runId]);
    }),
  );

  it.effect("quarantines a stopped run when private state reclamation fails", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { failReclaim: true }),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "reclaim-failure" }));
      const stopped = yield* service.stop(run.id);
      expect(stopped.state).toBe("stopped");
      expect(stopped.warning).toContain("remains quarantined");
      expect(fake.reclaimedRunIds).toEqual([run.id]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("coalesces streamed token activity publications", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
          usage: { totalTokens: 1 },
        },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 1);
      expect(projections).toHaveLength(beforeTokens + 1);

      yield* TestClock.adjust("1 second");
      const beforeActivityTick = projections.length;
      fake.controls[0]?.offer({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "next" },
      });
      yield* yieldUntil(() => projections.length === beforeActivityTick + 1);
      expect((yield* service.status(run.id)).lastActivityAt).toBe(run.lastActivityAt + 1_000);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("terminates a completed Pi process and restores its saved session", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "terminate-and-resume" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Assignment complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const completed = yield* service.status(run.id);
      expect(completed.state).toBe("completed");
      expect(completed.reportGeneration).toBe(1);
      expect(completed.pid).toBeUndefined();
      expect(completed.sessionFile).toBe("/tmp/child-session.jsonl");

      yield* service.rename(run.id, "renamed-before-resume");
      const resumed = yield* service.resume(run.id, "Continue from disk.");
      expect(resumed.state).toBe("running");
      expect(fake.controls).toHaveLength(2);
      expect(fake.controls[1]?.launch.name).toBe("renamed-before-resume");
      expect(fake.controls[1]?.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
      expect(fake.controls[1]?.commands.map((command) => command.type)).toEqual([
        "get_state",
        "prompt",
      ]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("reports a backend-generic error when completed resume state is unavailable", () => {
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { omitSessionFile: true }),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "no-resume-token" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Assignment complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      const failure = yield* service.resume(run.id).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_resume_unavailable",
      });
      expect(failure.message).toContain("local/pi did not provide continuation state");
      expect(failure.message).not.toContain("session file");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("waits for completed-process cleanup before restoring the session", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const cleanupGate = yield* Deferred.make<void>();
      const run = yield* service.start(request({ name: "cleanup-race" }));
      fake.controls[0]?.gateRelease(cleanupGate);
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Assignment complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("finalizes and releases slots when a backend awaitExit fails", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("drains buffered lifecycle output before processing child exit", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "exit-drain" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Final output before exit." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[0]?.exit(0);

      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const completed = yield* service.status(run.id);
      expect(completed.state).toBe("completed");
      expect(completed.finalText).toBe("Final output before exit.");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("continues a session-owned launch after its waiter is interrupted", () =>
    Effect.gen(function* () {
      const spawnGate = yield* Deferred.make<void>();
      const { projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(Deferred.await(spawnGate)),
      );

      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
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
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    }),
  );

  it.effect("settles interrupted startup as stopped without a warning", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
    const notifications: SubagentNotification[] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(request({ name: "cancelled-start" }))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "get_state") ?? false,
      );
      yield* Fiber.interrupt(starting);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
      expect(notifications).toEqual([]);
      expect(fake.controls[0]?.released()).toBe(1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      expect((yield* service.status(id!)).error).toBeUndefined();
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("allows local display rename for stopped runs", () => {
    const { fake, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "stopped-name" }));
      expect((yield* service.stop(run.id)).state).toBe("stopped");

      const renamed = yield* service.rename(run.id, "renamed-stopped-run");
      expect(renamed).toMatchObject({ state: "stopped", name: "renamed-stopped-run" });
      expect(
        fake.controls[0]?.commands.some((command) => command.type === "set_session_name"),
      ).toBe(false);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("preserves terminal state, completion delivery, and local completed rename", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const completedRun = yield* service.start(request({ name: "completed-name" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Assignment complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const before = projections.at(-1)?.runs.find((run) => run.id === completedRun.id);

      const renamed = yield* service.rename(completedRun.id, "retained-name");
      expect(renamed).toMatchObject({ state: "completed", name: "retained-name" });
      expect(
        fake.controls[0]?.commands.some((command) => command.type === "set_session_name"),
      ).toBe(false);
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("ignores child contact and lifecycle events after a run is terminal", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "terminal-reader" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Assignment complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      fake.controls[0]?.offerIpc(contactParentFrame("late-question", "question", "Too late?"));
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect((yield* service.status(run.id)).question).toBeUndefined();
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps a run stopped when startup finishes late", () =>
    Effect.gen(function* () {
      const spawnGate = yield* Deferred.make<void>();
      const cleanupOrder: string[] = [];
      const fake = fakeChildLayer(Deferred.await(spawnGate), {
        onRelease: () => cleanupOrder.push("backend"),
      });
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer(
        { publish: (projection) => projections.push(projection) },
        profileLayerFor({}),
        fakeWriterLeaseLayer({ onRelease: () => cleanupOrder.push("lease") }),
      ).pipe(Layer.provide(fake.layer));

      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
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
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    }),
  );

  it.effect("terminates a child after malformed known protocol input", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "bad-protocol" }));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.terminations).toContain("force");
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.list)[0]?.state).toBe("failed");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("clears the delivered final report while a completed run resumes", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-report" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "First report." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect((yield* service.status(run.id)).finalText).toBe("First report.");

      const resumed = yield* service.resume(run.id, "Continue");
      expect(resumed.state).toBe("running");
      expect(resumed.finalText).toBeUndefined();
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps a failed resume terminal and redacts the RPC error", () => {
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialFailures: [{ spawnIndex: 1, type: "prompt", error: "token=secret-value" }],
      }),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-failure" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Preserved report." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const failure = yield* Effect.flip(service.resume(run.id, "Continue"));
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain("secret-value");
      const failed = yield* service.status(run.id);
      expect(failed.state).toBe("failed");
      expect(failed.finalText).toBe("Preserved report.");
      expect(fake.controls[1]?.terminations).toContain("force");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("silently releases children when the session runtime is replaced", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service.start(request());
      }).pipe(Effect.scoped, provideBuiltLayer(layer));

      expect(fake.controls[0]?.released()).toBe(1);
      expect(notifications).toEqual([]);
    });
  });
});
