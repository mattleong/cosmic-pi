// Third-party AgentSession latch and explicit test entry-point Layer provision.
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/strictEffectProvide:off
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { advisorDelayEffect, advisorIntervalEffect } from "../src/boundary/clock.ts";
import { advisorPlatformLayer, standaloneAdvisorExecutor } from "../src/boundary/executor.ts";
import { ADVISOR_CATCH_UP_TIMEOUT_MS, awaitAdvisorCatchUpEffect } from "../src/extension.ts";
import { LONG_TURN_REVIEW_MS } from "../src/trajectory.ts";
import { AdvisorReviewQueue, type AdvisorReviewQueueOptions } from "../src/review-queue.ts";
import {
  AdvisorRuntime,
  MAX_ADVISOR_ABORT_MS,
  type AdvisorRuntimeDriver,
  type AdvisorRuntimeServiceShape,
} from "../src/advisor-runtime.ts";

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
      const scope = yield* Effect.scope;
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
      const driver: AdvisorRuntimeDriver = {
        activeToolNames: [],
        start: () => Promise.resolve(),
        checkpoint: () => Promise.reject(new Error("Promise driver must not run")),
        steer: () => Promise.resolve(false),
        reprime: () => Promise.resolve(),
        abort: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
      };
      const queue = new AdvisorReviewQueue(
        driver,
        {} satisfies AdvisorReviewQueueOptions,
        standaloneAdvisorExecutor,
        scope,
        effects,
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

  it.effect("bounds a hung AgentSession abort and still disposes exactly once", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const never = new Promise<void>(() => undefined);
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
        abort: vi.fn(() => never),
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
      yield* TestClock.adjust(MAX_ADVISOR_ABORT_MS - 1);
      expect(completed).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(abort);
      expect(completed).toBe(true);
      yield* runtime.disposeEffect().pipe(Effect.provide(advisorPlatformLayer));
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect("lets queue disposal and the shutdown path advance after a hung abort bound", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      let disposed = 0;
      const effects: AdvisorRuntimeServiceShape = {
        activeToolNames: () => [],
        start: () => Effect.void,
        checkpoint: () => Effect.never,
        steer: () => Effect.succeed(false),
        reprime: () => Effect.void,
        abort: () =>
          Effect.never.pipe(
            Effect.timeout(MAX_ADVISOR_ABORT_MS),
            Effect.catch(() => Effect.void),
          ),
        dispose: () =>
          Effect.sync(() => {
            disposed += 1;
          }),
      };
      const driver: AdvisorRuntimeDriver = {
        activeToolNames: [],
        start: () => Promise.resolve(),
        checkpoint: () => Promise.reject(new Error("Promise driver must not run")),
        steer: () => Promise.resolve(false),
        reprime: () => Promise.resolve(),
        abort: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
      };
      const queue = new AdvisorReviewQueue(driver, {}, standaloneAdvisorExecutor, scope, effects);
      yield* queue.initializeEffect();
      queue.ingest(1, { type: "user", text: "pending" });
      const checkpoint = yield* queue
        .checkpointEffect({ checkpointId: "hung", focus: "standard", parentTurnId: 1 })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const shutdown = yield* queue
        .disposeEffect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(MAX_ADVISOR_ABORT_MS - 1);
      expect(disposed).toBe(0);
      yield* TestClock.adjust(1);
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
});
