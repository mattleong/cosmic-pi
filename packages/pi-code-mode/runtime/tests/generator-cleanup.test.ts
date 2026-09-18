import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

describe("generator execution ownership", () => {
  it.live("bounds infinite async delegation by the execution deadline", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        limits: { timeoutMs: 50 },
        code: `
          async function* child() { while (true) yield 1; }
          async function* parent() { yield* child(); }
          const iterator = parent();
          while (true) await iterator.next();
        `,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("TimeoutExceeded");
    }),
  );

  it.live("does not drain an abandoned suspended body as pending work", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        limits: { timeoutMs: 1000 },
        code: `
        function* g() { yield 1; throw 'must not resume'; }
        async function* a() { yield 2; throw 'must not resume'; }
        const sync = g(); const async = a();
        return [sync.next().value, (await async.next()).value];
      `,
      });
      expect(result.ok && result.value).toEqual([1, 2]);
    }),
  );

  it.effect("keeps a synchronous resume within its caller's guest turn", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        function* g() { for (let i = 0; i < 5000; i++) {} trace.push('body'); yield 1; }
        Promise.resolve().then(() => trace.push('reaction'));
        const iterator = g(); iterator.next(); trace.push('caller');
        await 0; return trace;
      `,
      });
      expect(result.ok && result.value).toEqual(["body", "caller", "reaction"]);
    }),
  );

  it.effect("cancels owned tools without executing guest finally", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let interrupted = 0,
        guestCleanup = 0;
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
      });
      const cleanup = Tool.make({
        description: "Observe guest cleanup",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.sync(() => {
            guestCleanup++;
            return n;
          }),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow, cleanup },
          code: `
        async function* g() { try { yield await tools.slow(1); } finally { await tools.cleanup(1); } }
        async function* delegate() { try { yield* g(); } finally { await tools.cleanup(2); } }
        await delegate().next();
      `,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(interrupted).toBe(1);
      expect(guestCleanup).toBe(0);
    }),
  );

  it.live("cancels race-loser descendants after next has yielded", () =>
    Effect.gen(function* () {
      const bothStarted = Deferred.makeUnsafe<void>();
      let started = 0,
        interrupted = 0;
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.gen(function* () {
            started++;
            if (started === 2) yield* Deferred.succeed(bothStarted, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
      });
      const winner = Tool.make({
        description: "Wait for competing work",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) => Effect.as(Deferred.await(bothStarted), n),
      });
      const result = yield* CodeMode.execute({
        tools: { slow, winner },
        limits: { timeoutMs: 1000 },
        code: `
        async function* g() { tools.slow(1); yield 1; }
        async function losing() { const iterator = g(); await iterator.next(); return await tools.slow(2); }
        return await Promise.race([losing(), tools.winner(9)]);
      `,
      });
      expect(result.ok && result.value).toBe(9);
      expect(interrupted).toBe(2);
    }),
  );

  for (const position of ["middle", "tail"]) {
    it.effect(`preserves FIFO when a queued ${position} request loses a race`, () =>
      Effect.gen(function* () {
        const release = Deferred.makeUnsafe<void>();
        const queued = Deferred.makeUnsafe<void>();
        const slow = Tool.make({
          description: "Hold the active generator request",
          input: Schema.Number,
          output: Schema.Number,
          run: (n) => Effect.as(Deferred.await(release), n),
        });
        const checkpoint = Tool.make({
          description: "Report that the race and successor enqueue completed",
          input: Schema.Number,
          output: Schema.Number,
          run: (n) => Effect.as(Deferred.succeed(queued, undefined), n),
        });
        const fiber = yield* Effect.forkChild(
          CodeMode.execute({
            tools: { slow, checkpoint },
            code: `
              async function* g() { yield await tools.slow(1); yield 2; yield 3; }
              const a = g();
              const p = a.next();
              const q = a.next();
              ${position === "middle" ? "const kept = a.next();" : ""}
              await Promise.race([q, Promise.resolve(9)]);
              const r = a.next();
              await tools.checkpoint(0);
              return await Promise.all([p, ${position === "middle" ? "kept," : ""} r]);
            `,
          }),
        );
        yield* Deferred.await(queued);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        expect(result.ok && result.value).toEqual(
          (position === "middle" ? [1, 2, 3] : [1, 2]).map((value) => ({ value, done: false })),
        );
      }),
    );
  }

  it.effect("interrupts an active request and queued successors without waiting for the body", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const queued = Deferred.makeUnsafe<void>();
      let interrupted = 0;
      const slow = Tool.make({
        description: "Hold the active generator request until cancellation",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
      });
      const checkpoint = Tool.make({
        description: "Report queued successors",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) => Effect.as(Deferred.succeed(queued, undefined), n),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow, checkpoint },
          code: `
          async function* g() { yield await tools.slow(1); yield 2; }
          const a = g();
          const p = a.next();
          const q = a.next();
          await Promise.race([q, Promise.resolve(9)]);
          const r = a.next();
          const s = a.next();
          await tools.checkpoint(0);
          return await Promise.all([p, r, s]);
        `,
        }),
      );
      yield* Deferred.await(started);
      yield* Deferred.await(queued);
      yield* Fiber.interrupt(fiber);
      expect(interrupted).toBe(1);
    }),
  );

  it.effect("shares the eight tool permits across generator activations", () =>
    Effect.gen(function* () {
      const full = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>();
      let active = 0,
        maximum = 0;
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.gen(function* () {
            active++;
            maximum = Math.max(maximum, active);
            if (active === 8) yield* Deferred.succeed(full, undefined);
            yield* Deferred.await(release);
            active--;
            return n;
          }),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow },
          code: `
        async function* g(n) { yield await tools.slow(n); }
        return await Promise.all(Array.from({length: 12}, (_, n) => g(n).next()));
      `,
        }),
      );
      yield* Deferred.await(full);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.ok && result.value).toEqual(
        Array.from({ length: 12 }, (_, value) => ({ value, done: false })),
      );
      expect(maximum).toBe(8);
    }),
  );
});
