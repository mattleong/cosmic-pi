import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

const run = (code: string) => CodeMode.execute({ code, limits: { timeoutMs: 2000 } });

describe("promise scheduling and cleanup", () => {
  it.effect("orders ready values, async continuations, and adoption jobs consistently", () =>
    Effect.gen(function* () {
      const forms = (n: number) => [
        { source: `${n}`, jobs: 0, value: n },
        { source: `Promise.resolve(${n})`, jobs: 0, value: n },
        { source: `Promise.all([${n}])`, jobs: 1, value: [n] },
        {
          source: `Promise.allSettled([${n}])`,
          jobs: 1,
          value: [{ status: "fulfilled", value: n }],
        },
        { source: `Promise.race([${n}])`, jobs: 1, value: n },
        { source: `(async () => ${n})()`, jobs: 0, value: n },
        { source: `(async () => { await 0; return ${n}; })()`, jobs: 1, value: n },
        { source: `(async () => Promise.resolve(${n}))()`, jobs: 2, value: n },
        { source: `(async () => { await 0; return Promise.resolve(${n}); })()`, jobs: 3, value: n },
      ];
      for (const left of forms(1))
        for (const right of forms(2)) {
          const expected = left.jobs <= right.jobs ? left.value : right.value;
          expect(
            yield* run(`return await Promise.race([${left.source}, ${right.source}]);`),
          ).toMatchObject({ ok: true, value: expected });
        }
    }),
  );

  it.effect(
    "defers unhandled-rejection reporting until later continuations can observe failures",
    () =>
      Effect.gen(function* () {
        expect(
          yield* run(`const p = Promise.reject("late");
        async function handle() { await 0; try { await p; } catch {} }
        handle(); return 1;`),
        ).toMatchObject({ ok: true, value: 1 });
        const unhandled = yield* run(`async function fail() { await 0; throw "unhandled"; }
        fail(); return 1;`);
        expect(unhandled.ok).toBe(false);
        if (!unhandled.ok) expect(unhandled.error.message).toContain("unhandled");
      }),
  );

  it.effect("ancestor and cross-linked races cannot form interruption wait cycles", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`let p; async function f() { await 0; return await Promise.race([p, 1]); }
        p = f(); return await p;`),
      ).toMatchObject({ ok: true, value: 1 });
      expect(
        yield* run(`let p, q;
        async function f() { await 0; return await Promise.race([q, 1]); }
        async function g() { await 0; return await Promise.race([p, 2]); }
        p = f(); q = g(); return await Promise.race([p, q, 3]);`),
      ).toMatchObject({ ok: true, value: 3 });
    }),
  );

  it.live("long reaction chains and async recursion finish without exhausting the host stack", () =>
    Effect.gen(function* () {
      const cases = [
        [
          `let p = Promise.resolve(0);
          for (let i = 0; i < 5000; i++) p = p.then((x) => x + 1);
          return await p;`,
          5000,
        ],
        [
          `async function f(n) { if (n === 0) return 0; await null; return f(n - 1); }
          return await f(2000);`,
          0,
        ],
        [
          `const rows = Array.from({ length: 2000 }, (_, id) => ({ id }));
          const out = await Promise.all(rows.map(async (row) => ({ ...row, v: await row.id })));
          return out.length;`,
          2000,
        ],
      ] as const;
      for (const [code, value] of cases)
        expect(yield* CodeMode.execute({ code, limits: { timeoutMs: 10_000 } })).toMatchObject({
          ok: true,
          value,
        });
    }),
  );

  it.live("refuses more live async work than one execution may hold", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `const items = Array.from({ length: 20_000 }, (_, i) => i);
          return (await Promise.all(items.map(async (i) => { await null; return i; }))).length;`,
        limits: { timeoutMs: 10_000 },
      });
      expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } });
    }),
  );

  it.live("a runaway async loop still ends at the execution timeout", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: "async function f() { await null; f(); } f(); return 1;",
        limits: { timeoutMs: 200 },
      });
      expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
    }),
  );

  it.live("timeout teardown interrupts live calls together rather than one by one", () =>
    Effect.gen(function* () {
      const slowCleanup = Tool.make({
        description: "Wait, then clean up slowly when interrupted",
        input: Schema.Number,
        output: Schema.Number,
        run: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sleep("300 millis"))),
      });
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* CodeMode.execute({
        tools: { slowCleanup },
        code: "return await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((n) => tools.slowCleanup(n)));",
        limits: { timeoutMs: 100 },
      });
      expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
      // Sequential cleanup would take 8 x 300ms.
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(1_500);
    }),
  );

  it.effect("an await resumes after one queued reaction, as in native promises", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const log = [];
        const p = Promise.resolve();
        p.then(() => log.push("t1")).then(() => log.push("t2")).then(() => log.push("t3"));
        await null; log.push("main");
        await null; await null; await null;
        return log;`),
      ).toMatchObject({ ok: true, value: ["t1", "main", "t2", "t3"] });
    }),
  );

  it.effect("race preserves native reaction order for ready values and nested combinators", () =>
    Effect.gen(function* () {
      for (const expression of ["Promise.all([1])", "Promise.allSettled([1])", "Promise.race([1])"])
        expect(
          yield* run(`return await Promise.race([${expression}, Promise.resolve(2)]);`),
        ).toMatchObject({ ok: true, value: 2 });
      for (const expression of ["Promise.all([])", "Promise.allSettled([])"])
        expect(
          yield* run(`return await Promise.race([${expression}, Promise.resolve(2)]);`),
        ).toMatchObject({ ok: true, value: [] });
      for (const expression of ["1", "Promise.resolve(1)"])
        expect(
          yield* run(`return await Promise.race([${expression}, Promise.resolve(2)]);`),
        ).toMatchObject({ ok: true, value: 1 });
      expect(yield* run("return await Promise.all([, 1]);")).toMatchObject({
        ok: true,
        value: [null, 1],
      });
    }),
  );

  it.effect(
    "plain async returns settle synchronously but returned promises require adoption jobs",
    () =>
      Effect.gen(function* () {
        expect(
          yield* run(`async function f() { return 1; }
        return await Promise.race([f(), Promise.resolve(2)]);`),
        ).toMatchObject({ ok: true, value: 1 });
        expect(
          yield* run(`async function f() { return Promise.resolve(1); }
        return await Promise.race([f(), Promise.resolve(2)]);`),
        ).toMatchObject({ ok: true, value: 2 });
        expect(
          yield* run(`async function f() { throw 1; }
        return await Promise.allSettled([Promise.race([f(), Promise.resolve(2)])]);`),
        ).toMatchObject({ ok: true, value: [{ status: "rejected", reason: 1 }] });
        expect(
          yield* run(`async function f() { return Promise.reject(1); }
        try { await f(); } catch (e) { return e; }`),
        ).toMatchObject({ ok: true, value: 1 });
      }),
  );

  it.effect("rejects direct async promise self-resolution instead of waiting forever", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`let promise; async function f() { await 0; return promise; }
        promise = f(); try { await promise; } catch (error) { return error.name; }`),
      ).toMatchObject({ ok: true, value: "TypeError" });
    }),
  );

  it.effect("cancels descendants even when the losing async activation already fulfilled", () =>
    Effect.gen(function* () {
      let interrupted = 0;
      const slow = Tool.make({
        description: "Wait until interrupted",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++;
              }),
            ),
          ),
      });
      const result = yield* CodeMode.execute({
        tools: { slow },
        limits: { timeoutMs: 2000 },
        code: `async function child() { tools.slow(1); return 0; }
          async function loser() { child(); tools.slow(2); return 0; }
          return await Promise.race([9, loser()]);`,
      });
      expect(result).toMatchObject({ ok: true, value: 9 });
      expect(interrupted).toBe(2);
    }),
  );

  it.effect("duplicate winning promises do not cancel their outstanding children", () =>
    Effect.gen(function* () {
      const release = Deferred.makeUnsafe<void>();
      let completed = false,
        interrupted = false;
      const slow = Tool.make({
        description: "Wait for release",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.gen(function* () {
            yield* Deferred.await(release);
            completed = true;
            return n;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      });
      const unblock = Tool.make({
        description: "Release the child",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) => Effect.as(Deferred.succeed(release, undefined), n),
      });
      const result = yield* CodeMode.execute({
        tools: { slow, unblock },
        limits: { timeoutMs: 2000 },
        code: `async function f() { tools.slow(1); return 7; }
          const p = f(); const winner = await Promise.race([p, p]);
          await tools.unblock(0); return winner;`,
      });
      expect(result).toMatchObject({ ok: true, value: 7 });
      expect(completed).toBe(true);
      expect(interrupted).toBe(false);
    }),
  );

  it.effect("host cancellation releases a continuation waiting for the caller's guest turn", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let interrupted = false;
      const signal = Tool.make({
        description: "Signal the caller turn",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          n === 1
            ? Effect.succeed(n)
            : Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { signal },
          code: `async function f() { await tools.signal(1); return 1; }
          f(); tools.signal(2); while (true) {}`,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(interrupted).toBe(true);
    }),
  );

  it.effect("host cancellation interrupts an async synchronous prefix and its descendants", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let interrupted = false;
      const signal = Tool.make({
        description: "Signal entry",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { signal },
          code: `async function f() { tools.signal(0); while (true) {} } f();`,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(interrupted).toBe(true);
    }),
  );
});
