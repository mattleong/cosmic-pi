import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeInput,
} from "pi-background-task/code-mode";
import { yieldUntil } from "pi-cosmic-core/testing";
import { makeBackgroundTaskDispatch } from "../src/boundary/host-background-task.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const eventsFor = (execute: BackgroundTaskCodeModeCapability["execute"]) => {
  const events = createEventBus();
  events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) => {
    normalizeBackgroundTaskCodeModeQuery(value)?.respond({
      version: BACKGROUND_TASK_CODE_MODE_VERSION,
      sessionId: "session-1",
      execute: (callId, input, ...rest) => {
        // These fixtures model exit waits. Do not silently accept calls the real provider rejects.
        if (input.action === "wait") {
          expect(input.id).toBe("bg-1");
          expect(input.until).toBe("exit");
          expect(input.contains).toBeUndefined();
          expect(input.afterCursor).toBeUndefined();
        }
        return execute(callId, input, ...rest);
      },
    } satisfies BackgroundTaskCodeModeCapability);
  });
  return events;
};

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

const makeHarness = (events: ReturnType<typeof eventsFor>, runPromise: typeof Effect.runPromise) =>
  makeCodeModeToolExecute({
    events,
    sessionId: "session-1",
    isCurrent: () => true,
    getState: () => codeModeStateFixture({ timeoutMs: 30_000 }),
    runInSession: (effect, signal) => runPromise(effect, signal ? { signal } : undefined),
    definitions: nestedToolDefinitionsFixture({}),
  });

const ctx = extensionContextFixture({ cwd: "/project" });

describe("nested background wait deadlines", () => {
  it.effect("returns a default wait timeout before the outer execution times out", () =>
    Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const started = Deferred.makeUnsafe<void>();
      const execute = makeHarness(
        eventsFor((_id, input, signal) =>
          runPromise(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              // Model the owned provider's default and configured maximum, not an uncapped sleep.
              yield* Effect.sleep(Math.min(input.waitSeconds ?? 30, 30) * 1_000);
              return timeoutReply;
            }),
            { signal },
          ),
        ),
        runPromise,
      );
      let settled = false;
      const fiber = yield* Effect.tryPromise((signal) =>
        execute(
          "wait-default",
          {
            code: 'const reply = await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit" }); return reply.wait;',
          },
          signal,
          undefined,
          ctx,
        ),
      ).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(fiber));
      yield* TestClock.adjust("29 seconds");
      yield* yieldUntil(() => settled);
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
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const firstStarted = Deferred.makeUnsafe<void>();
      const secondStarted = Deferred.makeUnsafe<void>();
      const requested: number[] = [];
      const execute = makeHarness(
        eventsFor((_id, input, signal) =>
          runPromise(
            Effect.gen(function* () {
              requested.push(input.waitSeconds ?? 30);
              yield* Deferred.succeed(
                requested.length === 1 ? firstStarted : secondStarted,
                undefined,
              );
              yield* Effect.sleep((input.waitSeconds ?? 30) * 1_000);
              return timeoutReply;
            }),
            { signal },
          ),
        ),
        runPromise,
      );
      let settled = false;
      const fiber = yield* Effect.tryPromise((signal) =>
        execute(
          "wait-sequential",
          {
            code: `await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit", waitSeconds: 10 });
          const reply = await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit", waitSeconds: 120 });
          return reply.wait.outcome;`,
          },
          signal,
          undefined,
          ctx,
        ),
      ).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.raceFirst(Deferred.await(firstStarted), Fiber.join(fiber));
      yield* TestClock.adjust("10 seconds");
      yield* Effect.raceFirst(Deferred.await(secondStarted), Fiber.join(fiber));
      expect(requested).toEqual([10, 19]);
      yield* TestClock.adjust("19 seconds");
      yield* yieldUntil(() => settled);
      expect((yield* Fiber.join(fiber)).content).toEqual([{ type: "text", text: "timeout" }]);
    }),
  );

  it.effect("deducts time spent queued behind other nested calls", () =>
    Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const occupied = Deferred.makeUnsafe<void>();
      const queuedStarted = Deferred.makeUnsafe<void>();
      const requested: number[] = [];
      const execute = makeHarness(
        eventsFor((_id, input, signal) =>
          runPromise(
            Effect.gen(function* () {
              requested.push(input.waitSeconds ?? 30);
              if (requested.length === 8) yield* Deferred.succeed(occupied, undefined);
              if (requested.length === 9) yield* Deferred.succeed(queuedStarted, undefined);
              yield* Effect.sleep((input.waitSeconds ?? 30) * 1_000);
              return timeoutReply;
            }),
            { signal },
          ),
        ),
        runPromise,
      );
      let settled = false;
      const fiber = yield* Effect.tryPromise((signal) =>
        execute(
          "wait-queued",
          {
            code: `const requests = Array.from({ length: 9 }, (_, index) => ({
          action: "wait", id: "bg-1", until: "exit", waitSeconds: index < 8 ? 10 : 120
        }));
        const replies = await Promise.all(requests.map(input => tools.session.backgroundTask(input)));
        return replies.map(reply => reply.wait.outcome);`,
          },
          signal,
          undefined,
          ctx,
        ),
      ).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.raceFirst(Deferred.await(occupied), Fiber.join(fiber));
      yield* TestClock.adjust("10 seconds");
      yield* Effect.raceFirst(Deferred.await(queuedStarted), Fiber.join(fiber));
      expect(requested[8]).toBe(19);
      yield* TestClock.adjust("19 seconds");
      yield* yieldUntil(() => settled);
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
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const started = Deferred.makeUnsafe<void>();
      const interrupted = Deferred.makeUnsafe<void>();
      const execute = makeHarness(
        eventsFor((_id, _input, signal) =>
          runPromise(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            ),
            { signal },
          ),
        ),
        runPromise,
      );
      const fiber = yield* Effect.tryPromise((signal) =>
        execute(
          "wait-cancel",
          {
            code: 'return await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit" });',
          },
          signal,
          undefined,
          ctx,
        ),
      ).pipe(Effect.forkChild);
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
          return Promise.resolve(timeoutReply);
        }),
        sessionId: "session-1",
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
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      let calls = 0;
      const execute = makeHarness(
        eventsFor(() => {
          calls += 1;
          return Promise.resolve(timeoutReply);
        }),
        runPromise,
      );
      for (const value of ["-1", "121", "Infinity"]) {
        const result = yield* Effect.tryPromise((signal) =>
          execute(
            "invalid-wait",
            {
              code: `try { await tools.session.backgroundTask({ action: "wait", id: "bg-1", until: "exit", waitSeconds: ${value} }); return "accepted"; } catch { return "rejected"; }`,
            },
            signal,
            undefined,
            ctx,
          ),
        );
        expect(result.content).toEqual([{ type: "text", text: "rejected" }]);
      }
      expect(calls).toBe(0);
    }),
  );
});
