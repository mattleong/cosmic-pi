// Third-party AgentSession latch and explicit test entry-point Layer provision.
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/strictEffectProvide:off
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TestClock from "effect/testing/TestClock";
import { advisorDelayEffect, advisorIntervalEffect } from "../src/boundary/clock.ts";
import { advisorPlatformLayer, standaloneAdvisorExecutor } from "../src/boundary/executor.ts";
import { ADVISOR_CATCH_UP_TIMEOUT_MS, awaitAdvisorCatchUpEffect } from "../src/extension.ts";
import { LONG_TURN_REVIEW_MS } from "../src/review/trajectory.ts";
import {
  AdvisorReviewQueue,
  MAX_PENDING_CHECKPOINTS,
  type AdvisorReviewQueueOptions,
  type QueuedCheckpoint,
} from "../src/queue/service.ts";
import { initialReviewQueueState } from "../src/queue/state.ts";
import {
  AdvisorRuntime,
  AdvisorRuntimeResetRequiredError,
  type AdvisorRuntimeServiceShape,
} from "../src/runtime/runtime.ts";

const assertExactDelay = (milliseconds: number) =>
  Effect.gen(function* () {
    let fired = false;
    const fiber = yield* advisorDelayEffect(milliseconds, () => {
      fired = true;
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(milliseconds - 1);
    expect(fired).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(fiber);
    expect(fired).toBe(true);
  });

describe("advisor Effect clock boundaries", () => {
  it.effect(
    "uses the exact hard 30 second catch-up deadline and interrupts the late settlement",
    () =>
      Effect.gen(function* () {
        let finalized = false;
        const settlement = Effect.sleep(ADVISOR_CATCH_UP_TIMEOUT_MS + 1_000).pipe(
          Effect.as("completed" as const),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        );
        const fiber = yield* awaitAdvisorCatchUpEffect(
          settlement,
          ADVISOR_CATCH_UP_TIMEOUT_MS,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(ADVISOR_CATCH_UP_TIMEOUT_MS - 1);
        expect(finalized).toBe(false);
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(fiber)).toBe("timeout");
        expect(finalized).toBe(true);
      }),
  );

  it.effect("interrupts the real queue checkpoint at catch-up timeout and advances", () =>
    Effect.gen(function* () {
      const parentScope = yield* Effect.scope;
      const scope = yield* Scope.fork(parentScope);
      let attempts = 0;
      let interrupted = false;
      const effects: AdvisorRuntimeServiceShape = {
        activeToolNames: () => [],
        start: () => Effect.void,
        checkpoint: (request) => {
          attempts += 1;
          return attempts === 1
            ? Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              )
            : Effect.succeed({
                checkpointId: request.checkpointId,
                processedThrough: request.processedThrough,
                stateSummary: "",
                verdict: "pass" as const,
                summary: "pass",
                findings: [],
              });
        },
        steer: () => Effect.succeed(false),
        reprime: () => Effect.void,
        abort: () => Effect.void,
        dispose: () => Effect.void,
      };
      const queue = new AdvisorReviewQueue(
        effects,
        {} satisfies AdvisorReviewQueueOptions,
        scope,
        yield* SynchronizedRef.make(initialReviewQueueState()),
        yield* Queue.dropping<QueuedCheckpoint>(MAX_PENDING_CHECKPOINTS + 1),
      );
      yield* queue.initializeEffect();
      queue.ingest(1, { type: "user", text: "first" });
      const first = yield* queue
        .checkpointEffect({ checkpointId: "first", focus: "standard", parentTurnId: 1 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const wait = yield* awaitAdvisorCatchUpEffect(
        Fiber.join(first).pipe(
          Effect.as("completed" as const),
          Effect.catch(() => Effect.succeed("failed" as const)),
        ),
        ADVISOR_CATCH_UP_TIMEOUT_MS,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(ADVISOR_CATCH_UP_TIMEOUT_MS);
      expect(yield* Fiber.join(wait)).toBe("timeout");
      yield* queue.cancelCheckpointEffect("first");
      expect(interrupted).toBe(true);
      queue.ingest(2, { type: "user", text: "second" });
      expect(
        yield* queue.checkpointEffect({
          checkpointId: "second",
          focus: "standard",
          parentTurnId: 2,
        }),
      ).toMatchObject({ checkpointId: "second" });
      yield* queue.disposeEffect();
    }),
  );

  it.effect("awaits AgentSession abort settlement and still disposes exactly once", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      let releaseAbort!: () => void;
      const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const session = {
        sessionFile: undefined,
        messages: [],
        isStreaming: false,
        getActiveToolNames: () => [],
        getToolDefinition: () => undefined,
        subscribe: () => () => undefined,
        prompt: () => Promise.resolve(),
        steer: () => Promise.resolve(),
        followUp: () => Promise.resolve(),
        abort: vi.fn(() => abortGate),
        dispose: vi.fn(),
      } as unknown as AgentSession;
      const runtime = new AdvisorRuntime(
        {
          createChildModel: () =>
            Promise.resolve({
              modelRuntime: {} as never,
              model: { provider: "p", id: "m" } as never,
              thinkingLevel: "medium" as const,
            }),
          createTools: () => Promise.resolve([]),
          createSession: () => Promise.resolve({ session, extensionsResult: {} as never }),
        },
        standaloneAdvisorExecutor,
        scope,
        { offer: () => "accepted", shutdown: Effect.void, awaitShutdown: Effect.void },
        (yield* SynchronizedRef.make(undefined)) as never,
        yield* Semaphore.make(1),
      );
      yield* runtime
        .startEffect({
          ctx: { cwd: process.cwd(), modelRegistry: {} as never },
          config: {
            configPath: "/tmp/config",
            enabled: true,
            provider: "p",
            model: "m",
            fastMode: false,
            thinkingLevel: "medium",
            reviewPolicy: "guardrail",
            timeoutMs: 30_000,
            maxContextChars: 48_000,
            configured: true,
          },
          seed: "seed",
        })
        .pipe(Effect.provide(advisorPlatformLayer));
      let completed = false;
      const abort = yield* runtime.abortEffect().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      expect(completed).toBe(false);
      yield* Effect.sync(releaseAbort);
      yield* Fiber.join(abort);
      expect(completed).toBe(true);
      yield* runtime.disposeEffect().pipe(Effect.provide(advisorPlatformLayer));
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect("bounds a stuck AgentSession abort and requires a clean re-prime", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const makeSession = (abort: () => Promise<void>) =>
        ({
          sessionFile: undefined,
          messages: [],
          isStreaming: false,
          getActiveToolNames: () => [],
          getToolDefinition: () => undefined,
          subscribe: () => () => undefined,
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          followUp: () => Promise.resolve(),
          abort: vi.fn(abort),
          dispose: vi.fn(),
        }) as unknown as AgentSession;
      const stuck = makeSession(() => new Promise<void>(() => undefined));
      const fresh = makeSession(() => Promise.resolve());
      const sessions = [stuck, fresh];
      const runtime = new AdvisorRuntime(
        {
          createChildModel: () =>
            Promise.resolve({
              modelRuntime: {} as never,
              model: { provider: "p", id: "m" } as never,
              thinkingLevel: "medium" as const,
            }),
          createTools: () => Promise.resolve([]),
          createSession: () =>
            Promise.resolve({
              session: sessions.shift()!,
              extensionsResult: {} as never,
            }),
        },
        standaloneAdvisorExecutor,
        scope,
        { offer: () => "accepted", shutdown: Effect.void, awaitShutdown: Effect.void },
        (yield* SynchronizedRef.make(undefined)) as never,
        yield* Semaphore.make(1),
      );
      const options = {
        ctx: { cwd: process.cwd(), modelRegistry: {} as never },
        config: {
          configPath: "/tmp/config",
          enabled: true,
          provider: "p",
          model: "m",
          fastMode: false,
          thinkingLevel: "medium" as const,
          reviewPolicy: "guardrail" as const,
          timeoutMs: 25,
          maxContextChars: 48_000,
          configured: true,
        },
        seed: "seed",
      };
      yield* runtime.startEffect(options).pipe(Effect.provide(advisorPlatformLayer));
      let completed = false;
      const abort = yield* runtime.abortEffect().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(24);
      expect(completed).toBe(false);
      expect(stuck.dispose).not.toHaveBeenCalled();
      yield* TestClock.adjust(1);
      yield* Fiber.join(abort);
      expect(completed).toBe(true);
      expect(stuck.abort).toHaveBeenCalledOnce();
      expect(stuck.dispose).toHaveBeenCalledOnce();
      expect(runtime.childSession).toBeUndefined();

      const failure = yield* runtime
        .checkpointEffect({
          checkpointId: "must-reprime",
          processedThrough: 1,
          observations: "batch",
          focus: "standard",
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(AdvisorRuntimeResetRequiredError);

      yield* runtime.reprimeEffect("fresh").pipe(Effect.provide(advisorPlatformLayer));
      expect(runtime.childSession).toBe(fresh);
      (fresh.abort as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise<void>(() => undefined),
      );
      const interruptedAbort = yield* runtime
        .abortEffect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interruptedAbort);
      expect(runtime.childSession).toBeUndefined();
      expect(fresh.abort).toHaveBeenCalledOnce();
      expect(fresh.dispose).toHaveBeenCalledOnce();
      yield* runtime.disposeEffect().pipe(Effect.provide(advisorPlatformLayer));
      expect(stuck.dispose).toHaveBeenCalledOnce();
      expect(fresh.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect("keeps queue disposal blocked until the owned abort settles", () =>
    Effect.gen(function* () {
      const parentScope = yield* Effect.scope;
      const scope = yield* Scope.fork(parentScope);
      const abortGate = yield* Deferred.make<void>();
      let disposed = 0;
      const effects: AdvisorRuntimeServiceShape = {
        activeToolNames: () => [],
        start: () => Effect.void,
        checkpoint: () => Effect.never,
        steer: () => Effect.succeed(false),
        reprime: () => Effect.void,
        abort: () => Deferred.await(abortGate),
        dispose: () =>
          Effect.sync(() => {
            disposed += 1;
          }),
      };
      const queue = new AdvisorReviewQueue(
        effects,
        {},
        scope,
        yield* SynchronizedRef.make(initialReviewQueueState()),
        yield* Queue.dropping<QueuedCheckpoint>(MAX_PENDING_CHECKPOINTS + 1),
      );
      yield* queue.initializeEffect();
      queue.ingest(1, { type: "user", text: "pending" });
      const checkpoint = yield* queue
        .checkpointEffect({ checkpointId: "hung", focus: "standard", parentTurnId: 1 })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const shutdown = yield* queue
        .disposeEffect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(disposed).toBe(0);
      yield* Deferred.succeed(abortGate, undefined);
      yield* Fiber.join(shutdown);
      expect(disposed).toBe(1);
      expect((yield* Fiber.join(checkpoint))._tag).toBe("Failure");
    }),
  );

  it.effect("uses the exact long-turn trajectory deadline", () =>
    assertExactDelay(LONG_TURN_REVIEW_MS),
  );

  it.effect("keeps operation timeouts interruptible on the Effect clock", () =>
    Effect.gen(function* () {
      let completed = false;
      const fiber = yield* advisorDelayEffect(10_000, () => {
        completed = true;
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(9_999);
      expect(completed).toBe(false);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(1);
      expect(completed).toBe(false);
    }),
  );

  it.effect("drives spinner polling only after its fixed interval", () =>
    Effect.gen(function* () {
      let frames = 0;
      const fiber = yield* advisorIntervalEffect(120, () => {
        frames += 1;
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(119);
      expect(frames).toBe(0);
      yield* TestClock.adjust(1);
      expect(frames).toBe(1);
      yield* TestClock.adjust(120);
      expect(frames).toBe(2);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("recovers when a delayed timer callback throws", () =>
    Effect.gen(function* () {
      const fiber = yield* advisorDelayEffect(120, () => {
        throw new Error("sensitive delayed callback failure");
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(120);
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("keeps polling after an interval callback throws", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* advisorIntervalEffect(120, () => {
        attempts += 1;
        if (attempts === 1) throw new Error("sensitive interval callback failure");
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(240);
      expect(attempts).toBe(2);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
