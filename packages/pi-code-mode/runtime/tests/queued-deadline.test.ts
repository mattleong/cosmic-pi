// Local deviation-8 confinement regression for queued tool calls, not an upstream suite.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";
import { setDeadlineClockForTesting } from "../src/interpreter/deadline.js";

// The runtime's fixed tool-call concurrency: call `permits` is the first to queue.
const permits = 8;
const timeoutMs = 5_000;
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const sorted = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b);

// Only the cooperative deadline reads this clock. The Effect TestClock never advances, so the
// Effect timeout cannot fire first and each expiry below is the cooperative deadline's alone.
const withDeadlineClock = <A, E, R>(body: (clock: { now: number }) => Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const clock = { now: 0 };
    setDeadlineClockForTesting(() => clock.now);
    return body(clock);
  }).pipe(Effect.ensuring(Effect.sync(() => setDeadlineClockForTesting(undefined))));

// Calls 0..7 hold every permit behind their own gates; later calls queue for a permit.
const holdPermits = (combinator: "all" | "allSettled", queued: number) =>
  Effect.gen(function* () {
    const total = permits + queued;
    const gates = ids(0, permits).map(() => Deferred.makeUnsafe<void>());
    const permitsHeld = Deferred.makeUnsafe<void>();
    const allQueued = Deferred.makeUnsafe<void>();
    const queuedDispatched = Deferred.makeUnsafe<void>();
    const dispatched: Array<number> = [];
    const interrupted: Array<number> = [];
    const events: Array<CodeMode.ToolCallLifecycleEvent> = [];
    const work = Tool.make({
      description: "Hold a permit until released",
      input: Schema.Struct({ id: Schema.Finite }),
      output: Schema.Finite,
      run: ({ id }) =>
        Effect.suspend(() => {
          dispatched.push(id);
          const gate = gates[id];
          if (gate === undefined) return Deferred.succeed(queuedDispatched, undefined);
          return Effect.andThen(
            dispatched.length === permits ? Deferred.succeed(permitsHeld, undefined) : Effect.void,
            Deferred.await(gate).pipe(
              Effect.onInterrupt(() => Effect.sync(() => interrupted.push(id))),
            ),
          );
        }).pipe(Effect.as(id)),
    });
    const calls = ids(0, total).map((id) => `tools.work({ id: ${id} })`);
    const fiber = yield* Effect.forkChild(
      CodeMode.execute({
        tools: { work },
        code: `return await Promise.${combinator}([${calls.join(", ")}]);`,
        limits: { timeoutMs },
        onToolCallLifecycle: (event) =>
          Effect.suspend(() => {
            events.push(event);
            return event.status === "queued" && event.id === total - 1
              ? Effect.asVoid(Deferred.succeed(allQueued, undefined))
              : Effect.void;
          }),
      }),
    );
    // Every held call passed admission and dispatch; every later call is waiting for a permit.
    yield* Deferred.await(permitsHeld);
    yield* Deferred.await(allQueued);
    return {
      fiber,
      gates,
      queuedDispatched,
      dispatched,
      interrupted,
      eventsFor: (id: number) => events.filter((event) => event.id === id),
    };
  });

describe("queued tool calls and the cooperative deadline", () => {
  it.effect("never starts or dispatches a queued call whose permit arrives after expiry", () =>
    withDeadlineClock((clock) =>
      Effect.gen(function* () {
        const run = yield* holdPermits("allSettled", 2);
        clock.now = timeoutMs + 1;
        for (const gate of run.gates) yield* Deferred.succeed(gate, undefined);

        const result = yield* Fiber.join(run.fiber);
        expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
        expect(sorted(run.dispatched)).toEqual(ids(0, permits));
        expect(result.toolCalls).toHaveLength(permits);
        for (const id of ids(0, permits))
          expect(run.eventsFor(id)).toMatchObject([
            { status: "queued" },
            { status: "running" },
            { status: "succeeded", started: true },
          ]);
        for (const id of ids(permits, permits + 2))
          expect(run.eventsFor(id)).toMatchObject([
            { status: "queued" },
            { status: "failed", started: false },
          ]);
      }),
    ),
  );

  it.effect(
    "settles an expired queued call without waiting for held calls, then tears them down",
    () =>
      withDeadlineClock((clock) =>
        Effect.gen(function* () {
          const run = yield* holdPermits("all", 1);
          clock.now = timeoutMs + 1;
          yield* Deferred.succeed(run.gates[0]!, undefined);

          // Calls 1..7 are never released: only teardown can end them.
          const outcome = yield* Effect.raceFirst(
            Fiber.join(run.fiber),
            Deferred.await(run.queuedDispatched).pipe(Effect.as("queued call dispatched")),
          );
          expect(outcome).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
          expect(sorted(run.dispatched)).toEqual(ids(0, permits));
          expect(sorted(run.interrupted)).toEqual(ids(1, permits));
          expect(run.eventsFor(0)).toMatchObject([
            { status: "queued" },
            { status: "running" },
            { status: "succeeded", started: true },
          ]);
          for (const id of ids(1, permits))
            expect(run.eventsFor(id)).toMatchObject([
              { status: "queued" },
              { status: "running" },
              { status: "cancelled", started: true },
            ]);
          expect(run.eventsFor(permits)).toMatchObject([
            { status: "queued" },
            { status: "failed", started: false },
          ]);
        }),
      ),
  );

  it.effect("still dispatches a queued call whose permit arrives before expiry", () =>
    withDeadlineClock((clock) =>
      Effect.gen(function* () {
        const run = yield* holdPermits("all", 1);
        clock.now = timeoutMs - 1;
        for (const gate of run.gates) yield* Deferred.succeed(gate, undefined);

        const result = yield* Fiber.join(run.fiber);
        expect(result).toMatchObject({ ok: true, value: ids(0, permits + 1) });
        expect(sorted(run.dispatched)).toEqual(ids(0, permits + 1));
        expect(result.toolCalls).toHaveLength(permits + 1);
        expect(run.eventsFor(permits)).toMatchObject([
          { status: "queued" },
          { status: "running" },
          { status: "succeeded", started: true },
        ]);
      }),
    ),
  );

  it.effect("still reports host cancellation of a queued call as cancelled and never started", () =>
    withDeadlineClock(() =>
      Effect.gen(function* () {
        const run = yield* holdPermits("all", 1);
        yield* Fiber.interrupt(run.fiber);

        expect(sorted(run.dispatched)).toEqual(ids(0, permits));
        expect(sorted(run.interrupted)).toEqual(ids(0, permits));
        expect(run.eventsFor(permits)).toMatchObject([
          { status: "queued" },
          { status: "cancelled", started: false },
        ]);
      }),
    ),
  );

  it.effect("refuses a call over the limit at once, without waiting for a permit", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const refused = Deferred.makeUnsafe<CodeMode.ToolCallLifecycleEvent>();
      const events: Array<CodeMode.ToolCallLifecycleEvent> = [];
      const work = Tool.make({
        description: "Hold a permit until released",
        input: Schema.Struct({ id: Schema.Finite }),
        output: Schema.Finite,
        run: ({ id }) => Effect.as(Deferred.await(gate), id),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { work },
          code: `const held = [${ids(0, permits).join(", ")}].map((id) => tools.work({ id }));
            let refusal; try { await tools.work({ id: ${permits} }); } catch (error) { refusal = error.message; }
            await Promise.all(held); return refusal;`,
          limits: { maxToolCalls: permits, timeoutMs },
          onToolCallLifecycle: (event) =>
            Effect.suspend(() => {
              events.push(event);
              return event.id === permits && event.status === "failed"
                ? Effect.asVoid(Deferred.succeed(refused, event))
                : Effect.void;
            }),
        }),
      );
      // Every permit is still held here, so the refusal cannot have waited for one.
      expect(yield* Deferred.await(refused)).toMatchObject({
        started: false,
        failure: { kind: "ToolCallLimitExceeded" },
      });
      expect(events.filter((event) => event.id === permits).map((event) => event.status)).toEqual([
        "queued",
        "failed",
      ]);
      yield* Deferred.succeed(gate, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ ok: true });
      expect(result.toolCalls).toHaveLength(permits);
    }),
  );
});
