import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type {
  BackgroundTaskCodeModeCapability,
  BackgroundTaskCodeModeInput,
  BackgroundTaskCodeModeOutput,
} from "pi-background-task/code-mode";
import { yieldUntil } from "pi-cosmic-core/testing";
import { makeBackgroundTaskDispatch } from "../src/boundary/host-background-task.ts";
import { executeHarness } from "./support/execute.ts";
import { backgroundTaskProvider, TEST_SESSION_ID } from "./support/providers.ts";

const eventsFor = (execute: BackgroundTaskCodeModeCapability["execute"]) =>
  backgroundTaskProvider((callId, input, ...rest) => {
    // These fixtures model exit waits. Do not silently accept calls the real provider rejects.
    if (input.action === "wait") {
      expect(input.id).toBe("bg-1");
      expect(input.until).toBe("exit");
      expect(input.contains).toBeUndefined();
      expect(input.afterCursor).toBeUndefined();
    }
    return execute(callId, input, ...rest);
  });

const timeoutReply = {
  action: "wait" as const,
  text: "Still running",
  wait: {
    id: "bg-1",
    outcome: "timeout" as const,
    snapshot: {
      id: "bg-1",
      command: "server",
      cwd: "/project",
      state: "running" as const,
      startedAt: 0,
      logCursor: 0,
      droppedLogBytes: 0,
    },
    nextCursor: 0,
    earliestAvailableCursor: 0,
    droppedBytes: 0,
  },
};

type WaitProvider = (
  input: BackgroundTaskCodeModeInput,
) => Effect.Effect<BackgroundTaskCodeModeOutput>;

/** Executions whose provider calls run as Effects on the test runtime, under TestClock. */
const waitExecute = (provide: WaitProvider) =>
  Effect.map(Effect.context<never>(), (context) => {
    const runPromise = Effect.runPromiseWith(context);
    const { run } = executeHarness({
      runPromise,
      cwd: "/project",
      config: { timeoutMs: 30_000 },
      events: eventsFor((_id, input, signal) => runPromise(provide(input), { signal })),
    });
    return (code: string) => Effect.tryPromise((signal) => run(code, { signal }));
  });

/** Forks one execution and reports whether it has settled. */
const forkExecute = (provide: WaitProvider, code: string) =>
  Effect.gen(function* () {
    const execute = yield* waitExecute(provide);
    let settled = false;
    const fiber = yield* execute(code).pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          settled = true;
        }),
      ),
      Effect.forkChild,
    );
    return { fiber, settled: () => settled };
  });

describe("nested background wait deadlines", () => {
  it.effect("returns a default wait timeout before the outer execution times out", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const { fiber, settled } = yield* forkExecute(
        (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            // Model the owned provider's default and configured maximum, not an uncapped sleep.
            yield* Effect.sleep(Math.min(input.waitSeconds ?? 30, 30) * 1_000);
            return timeoutReply;
          }),
        'const reply = await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit" }); return reply.wait;',
      );
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(fiber));
      yield* TestClock.adjust("29 seconds");
      yield* yieldUntil(settled);
      const result = yield* Fiber.join(fiber);
      expect(result.content).toEqual([
        {
          type: "text",
          text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            timeoutReply.wait,
          ),
        },
      ]);
      expect(result.details.cancelled).not.toBe(true);
    }),
  );

  it.effect("shares the remaining deadline across sequential waits", () =>
    Effect.gen(function* () {
      const firstStarted = Deferred.makeUnsafe<void>();
      const secondStarted = Deferred.makeUnsafe<void>();
      const requested: number[] = [];
      const { fiber, settled } = yield* forkExecute(
        (input) =>
          Effect.gen(function* () {
            requested.push(input.waitSeconds ?? 30);
            yield* Deferred.succeed(
              requested.length === 1 ? firstStarted : secondStarted,
              undefined,
            );
            yield* Effect.sleep((input.waitSeconds ?? 30) * 1_000);
            return timeoutReply;
          }),
        `await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit", waitSeconds: 10 });
          const reply = await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit", waitSeconds: 120 });
          return reply.wait.outcome;`,
      );
      yield* Effect.raceFirst(Deferred.await(firstStarted), Fiber.join(fiber));
      yield* TestClock.adjust("10 seconds");
      yield* Effect.raceFirst(Deferred.await(secondStarted), Fiber.join(fiber));
      expect(requested).toEqual([10, 19]);
      yield* TestClock.adjust("19 seconds");
      yield* yieldUntil(settled);
      expect((yield* Fiber.join(fiber)).content).toEqual([{ type: "text", text: "timeout" }]);
    }),
  );

  it.effect("deducts time spent queued behind other nested calls", () =>
    Effect.gen(function* () {
      const occupied = Deferred.makeUnsafe<void>();
      const queuedStarted = Deferred.makeUnsafe<void>();
      const requested: number[] = [];
      const { fiber, settled } = yield* forkExecute(
        (input) =>
          Effect.gen(function* () {
            requested.push(input.waitSeconds ?? 30);
            if (requested.length === 8) yield* Deferred.succeed(occupied, undefined);
            if (requested.length === 9) yield* Deferred.succeed(queuedStarted, undefined);
            yield* Effect.sleep((input.waitSeconds ?? 30) * 1_000);
            return timeoutReply;
          }),
        `const requests = Array.from({ length: 9 }, (_, index) => ({
          action: "wait", id: "bg-1", until: "exit", waitSeconds: index < 8 ? 10 : 120
        }));
        const replies = await Promise.all(requests.map(input => tools.session.backgroundTask(input)));
        return replies.map(reply => reply.wait.outcome);`,
      );
      yield* Effect.raceFirst(Deferred.await(occupied), Fiber.join(fiber));
      yield* TestClock.adjust("10 seconds");
      yield* Effect.raceFirst(Deferred.await(queuedStarted), Fiber.join(fiber));
      expect(requested[8]).toBe(19);
      yield* TestClock.adjust("19 seconds");
      yield* yieldUntil(settled);
      expect((yield* Fiber.join(fiber)).content).toEqual([
        {
          type: "text",
          text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
            Array.from({ length: 9 }, () => "timeout"),
          ),
        },
      ]);
    }),
  );

  it.effect("propagates outer cancellation to an in-flight provider wait", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const interrupted = Deferred.makeUnsafe<void>();
      const { fiber } = yield* forkExecute(
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          ),
        'return await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit" });',
      );
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(fiber));
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("bounds waits and long polls without changing nonblocking or unrelated requests", () =>
    Effect.gen(function* () {
      const received: BackgroundTaskCodeModeInput[] = [];
      const dispatch = makeBackgroundTaskDispatch({
        events: eventsFor((_id, input) => {
          received.push(input);
          if (input.action === "logs")
            return Promise.resolve({
              action: "logs",
              text: "",
              logs: {
                id: "bg-1",
                nextCursor: 0,
                earliestAvailableCursor: 0,
                droppedBytes: 0,
                state: "running",
              },
            });
          if (input.action === "start")
            return Promise.resolve({
              action: "start",
              text: "Started",
              snapshot: timeoutReply.wait.snapshot,
            });
          return Promise.resolve(timeoutReply);
        }),
        sessionId: TEST_SESSION_ID,
        toolCallId: "bounds",
        deadlineMillis: (yield* Clock.currentTimeMillis) + 5_000,
        maxOutputBytes: () => 10_000,
      });
      const inputs: BackgroundTaskCodeModeInput[] = [
        { action: "wait", id: "bg-1", until: "exit" },
        { action: "wait", id: "bg-1", until: "exit", waitSeconds: 120 },
        { action: "wait", id: "bg-1", until: "exit", waitSeconds: 0.25 },
        { action: "wait", id: "bg-1", until: "exit", waitSeconds: 0 },
        { action: "logs", id: "bg-1", waitSeconds: 120, afterCursor: 2 },
        { action: "logs", id: "bg-1" },
        { action: "logs", id: "bg-1", waitSeconds: 0 },
        { action: "start", command: "server", timeoutSeconds: 60 },
      ];
      for (const input of inputs) yield* dispatch(input);
      expect(received).toEqual([
        { ...inputs[0], waitSeconds: 4 },
        { ...inputs[1], waitSeconds: 4 },
        inputs[2],
        inputs[3],
        { ...inputs[4], waitSeconds: 4 },
        inputs[5],
        inputs[6],
        inputs[7],
      ]);
      // Reaching the reserve or passing the deadline turns waits into immediate inspections.
      yield* TestClock.adjust("4 seconds");
      yield* dispatch({ action: "wait", id: "bg-1", until: "exit" });
      yield* TestClock.adjust("2 seconds");
      yield* dispatch({ action: "logs", id: "bg-1", waitSeconds: 20 });
      expect(received.slice(-2).map((input) => input.waitSeconds)).toEqual([0, 0]);
      expect(inputs[0]).not.toHaveProperty("waitSeconds");
      expect(inputs[1]?.waitSeconds).toBe(120);
    }),
  );

  it.effect("rejects invalid wait values before dispatching to the provider", () =>
    Effect.gen(function* () {
      let calls = 0;
      const execute = yield* waitExecute(() =>
        Effect.sync(() => {
          calls += 1;
          return timeoutReply;
        }),
      );
      for (const value of ["-1", "121", "Infinity"]) {
        const result = yield* execute(
          `try { await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit", waitSeconds: ${value} }); return "accepted"; } catch { return "rejected"; }`,
        );
        expect(result.content).toEqual([{ type: "text", text: "rejected" }]);
      }
      expect(calls).toBe(0);
    }),
  );
});
