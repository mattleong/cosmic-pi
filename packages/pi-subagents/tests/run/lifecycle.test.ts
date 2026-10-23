import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  completeLocalRun,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  localServiceFixture,
  profileLayerFor,
  request,
  runView,
  runViews,
  withService,
} from "./fixtures/service-harness.ts";
import { stringContaining } from "../support/matchers.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

describe("SubagentService", () => {
  it.effect("caps active runs across the whole tree, not only per parent", () => {
    const { layer } = localServiceFixture();
    const nestingPolicy = { maxDirectChildren: 12, maxDepth: 3, maxActiveRuns: 2 };
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ nestingPolicy }));
      yield* service.start(request({ nestingPolicy, parentRunId: parent.id }));
      expect(yield* service.start(request({ nestingPolicy })).pipe(Effect.flip)).toMatchObject({
        code: "tree_capacity",
        limit: 2,
      });
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
        const before = yield* runView(service, run.id);
        gate = true;
        const waiter = yield* service.resume(run.id).pipe(Effect.forkChild);
        yield* yieldUntil(() => entered);
        yield* service.rename(run.id, "lock-reused");
        yield* Fiber.interrupt(waiter);
        expect(yield* runView(service, run.id)).toMatchObject({
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
      expect(started.id).toMatch(/\S/);

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
      expect((yield* runView(service, started.id)).finalText).toBeUndefined();

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const completed = yield* runView(service, started.id);
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
      yield* yieldUntil(() =>
        Option.exists(Arr.last(projections), (projection) =>
          Arr.some(projection.runs, (run) => run.id === failedRun.id && run.state === "failed"),
        ),
      );
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failed = yield* runView(service, failedRun.id);
      expect(failed).toMatchObject({
        state: "failed",
        error: stringContaining("Fixture awaitExit failure"),
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
      const completed = yield* runView(service, run.id);
      expect(completed.state).toBe("completed");
      expect(completed.finalText).toBe("Final output before exit.");
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
        expect((yield* runView(service, id!)).state).toBe("stopped");
        expect(fake.reclaimedRunIds).toEqual([]);
        expect(cleanupOrder).toEqual(["backend", "lease"]);
      });
      expect(fake.reclaimedRunIds).toHaveLength(1);
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
      expect((yield* runViews(service))[0]?.state).toBe("failed");
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
