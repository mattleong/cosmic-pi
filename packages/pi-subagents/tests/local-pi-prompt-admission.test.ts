import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { localPiBackendDriver } from "../src/backend/local-pi.ts";
import type { RpcCommand } from "../src/backend/local-pi-protocol.ts";
import type { BackendHandle } from "../src/backend/model.ts";
import type { ChildWireEvent } from "../src/boundary/child-process.ts";
import { isOutcomeUncertain } from "../src/run/errors.ts";
import { backendLaunch, takeBackendEvent } from "./fixtures/backend-supervisor.ts";

type Prompt = Extract<RpcCommand, { readonly type: "prompt" }>;

const piFixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
  const prompts = yield* Queue.unbounded<Prompt>();
  const emit = (value: Schema.Json) =>
    Queue.offer(events, { type: "rpc_message", value }).pipe(Effect.asVoid);
  const respond = (prompt: Prompt, data: Schema.Json | undefined, success = true) =>
    emit({
      type: "response",
      ...(prompt.id && { id: prompt.id }),
      command: "prompt",
      success,
      ...(data !== undefined && { data }),
    });
  const driver = localPiBackendDriver({
    reclaimRunState: () => Effect.void,
    spawn: () =>
      Effect.succeed({
        pid: 4242,
        events,
        awaitExit: Effect.never,
        send: (command) => {
          if (command.type === "prompt") return Queue.offer(prompts, command).pipe(Effect.asVoid);
          return emit({
            type: "response",
            ...(command.id && { id: command.id }),
            command: command.type,
            success: true,
            data:
              command.type === "get_state"
                ? { thinkingLevel: "high", sessionId: "fixture-session" }
                : {
                    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    cost: 0,
                  },
          });
        },
        acknowledge: () => {},
        sendContactControl: () => Effect.void,
        terminate: () => Effect.void,
      }),
  });
  const backend = yield* driver.spawn(backendLaunch());
  yield* backend.controls.initialize;
  const start = (epoch: number, data: Schema.Json | undefined, success = true) =>
    Effect.gen(function* () {
      const starting = yield* backend.controls
        .start("task", epoch)
        .pipe(Effect.exit, Effect.forkScoped);
      const prompt = yield* Queue.take(prompts);
      yield* respond(prompt, data, success);
      return yield* Fiber.join(starting);
    });
  return { backend, emit, prompts, respond, start };
});

const expectEpoch = (backend: BackendHandle, epoch: number) =>
  Effect.gen(function* () {
    expect(yield* takeBackendEvent(backend, { acknowledge: true })).toMatchObject({
      type: "run_started",
      assignmentEpoch: epoch,
    });
  });

describe("local Pi task admission", () => {
  for (const disposition of ["started", "queued"] as const) {
    it.effect(
      `accepts ${disposition} and associates subsequent lifecycle with the assignment`,
      () =>
        Effect.gen(function* () {
          const { backend, emit, start } = yield* piFixture;
          expect(Exit.isSuccess(yield* start(7, { disposition }))).toBe(true);
          yield* emit({ type: "agent_start" });
          yield* expectEpoch(backend, 7);
        }),
    );
  }

  it.effect("preserves lifecycle that arrives before task admission is confirmed", () =>
    Effect.gen(function* () {
      const { backend, emit, prompts, respond } = yield* piFixture;
      const starting = yield* backend.controls.start("fast task", 5).pipe(Effect.forkScoped);
      const prompt = yield* Queue.take(prompts);
      yield* emit({ type: "agent_start" });
      yield* expectEpoch(backend, 5);
      yield* emit({ type: "agent_settled" });
      const settled = yield* takeBackendEvent(backend, { acknowledge: true });
      expect(settled).toMatchObject({ type: "run_settled", assignmentEpoch: 5 });

      yield* respond(prompt, { disposition: "started" });
      yield* Fiber.join(starting);

      expect(backend.controls.isSettlementCurrent?.(settled)).toBe(true);
    }),
  );

  for (const rejection of ["handled", "rejected"] as const) {
    it.effect(`restores the prior epoch and terminal evidence after a ${rejection} task`, () =>
      Effect.gen(function* () {
        const { backend, emit, start } = yield* piFixture;
        expect(Exit.isSuccess(yield* start(1, { disposition: "started" }))).toBe(true);
        yield* emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "prior report" }],
            stopReason: "stop",
          },
        });
        expect(yield* takeBackendEvent(backend, { acknowledge: true })).toMatchObject({
          type: "assistant_message",
          assignmentEpoch: 1,
        });

        const result = yield* start(2, { disposition: "handled" }, rejection !== "rejected");
        const error = yield* Effect.flip(result);
        if (!Predicate.isTagged(error, "SubagentProcessError")) return yield* Effect.die(error);
        if (rejection === "handled") expect(error).toMatchObject({ code: "prompt_not_delivered" });
        expect(isOutcomeUncertain(error)).toBe(false);
        yield* emit({ type: "agent_settled" });
        expect(yield* takeBackendEvent(backend, { acknowledge: true })).toMatchObject({
          type: "run_settled",
          assignmentEpoch: 1,
          terminal: { text: "prior report", stopReason: "stop" },
        });
        return undefined;
      }),
    );
  }

  for (const data of [undefined, null, {}, { disposition: "future-secret" }, { disposition: 9 }]) {
    it.effect(
      `retains the attempted epoch when admission data is unreadable: ${JSON.stringify(data)}`,
      () =>
        Effect.gen(function* () {
          const { backend, emit, start } = yield* piFixture;
          expect(Exit.isSuccess(yield* start(1, { disposition: "started" }))).toBe(true);
          const result = yield* start(2, data);
          const error = yield* Effect.flip(result);
          if (!Predicate.isTagged(error, "SubagentProcessError")) return yield* Effect.die(error);
          expect(error).toMatchObject({ code: "prompt_outcome_uncertain" });
          expect(isOutcomeUncertain(error)).toBe(true);
          expect(error.message).not.toContain("future-secret");
          yield* emit({ type: "agent_start" });
          yield* expectEpoch(backend, 2);
          return undefined;
        }),
    );
  }

  it.effect(
    "retains attempted ownership after a missing prompt response without replaying the task",
    () =>
      Effect.gen(function* () {
        const { backend, emit, prompts } = yield* piFixture;
        const starting = yield* backend.controls
          .start("task", 3)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Queue.take(prompts);
        yield* TestClock.adjust("10 seconds");
        const error = yield* Fiber.join(starting);
        expect(error).toMatchObject({ code: "prompt_outcome_uncertain" });
        expect(Queue.sizeUnsafe(prompts)).toBe(0);
        yield* emit({ type: "agent_start" });
        yield* expectEpoch(backend, 3);
      }),
  );

  it.effect(
    "keeps cancellation interruptible and does not roll back a possibly admitted task",
    () =>
      Effect.gen(function* () {
        const { backend, emit, prompts, respond } = yield* piFixture;
        const starting = yield* backend.controls.start("task", 4).pipe(Effect.forkScoped);
        const prompt = yield* Queue.take(prompts);
        yield* Fiber.interrupt(starting);
        expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
        yield* respond(prompt, { disposition: "started" });
        yield* emit({ type: "agent_start" });
        yield* expectEpoch(backend, 4);
        expect(Queue.sizeUnsafe(prompts)).toBe(0);
      }),
  );
});
