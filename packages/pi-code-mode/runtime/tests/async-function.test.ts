import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

const value = (code: string) =>
  Effect.map(CodeMode.execute({ tools: {}, code }), (result) => {
    if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
    return result.value;
  });

describe("async function activations", () => {
  it.effect("creates distinct promises and adopts returned promises", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const inner = Promise.resolve(7);
      async function f() { return inner; }
      const a = f(), b = f();
      const arrow = async () => 8;
      return [a instanceof Promise, a !== b, a !== inner, Promise.resolve(a) === a, await a, await arrow()];
    `),
      ).toEqual([true, true, true, true, 7, 8]);
    }),
  );

  it.effect("converts prefix throws to rejection, including parameter defaults", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      let escaped = false;
      async function f() { throw new Error('prefix'); }
      let p;
      try { p = f(); } catch { escaped = true; }
      let message;
      try { await p; } catch (e) { message = e.message; }
      async function bad(a = b, b = 1) { return a; }
      return [escaped, message, (await Promise.allSettled([bad()]))[0].status];
    `),
      ).toEqual([false, "prefix", "rejected"]);
    }),
  );

  it.effect("finishes long prefixes and keeps continuations out of long caller turns", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const trace = [];
      async function f() {
        for (let i = 0; i < 5000; i++) {}
        trace.push('prefix');
        await 0;
        trace.push('after');
      }
      const p = f();
      for (let i = 0; i < 5000; i++) {}
      trace.push('caller');
      await p;
      return trace;
    `),
      ).toEqual(["prefix", "caller", "after"]);
    }),
  );

  it.effect("evaluates await operands before handing control to the caller", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const trace = [];
      function operand() { trace.push('operand'); return 0; }
      async function f() { trace.push('prefix'); await operand(); trace.push('after'); }
      const p = f(); trace.push('caller'); await 0; trace.push('root'); await p;
      return trace;
    `),
      ).toEqual(["prefix", "operand", "caller", "after", "root"]);
    }),
  );

  it.effect("isolates concurrent scopes while sharing captured binding writes", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      let shared = 0;
      function sync(n) { let local = n * 10; return local; }
      async function f(n) {
        let local = n;
        const capture = () => local;
        await 0;
        local += sync(n);
        shared += n;
        await 0;
        return capture();
      }
      const results = await Promise.all([f(1), f(2), f(3)]);
      return [results, shared];
    `),
      ).toEqual([[11, 22, 33], 6]);
    }),
  );

  it.effect("nested async prefixes borrow the current guest turn", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const trace = [];
      async function child() { trace.push('child'); await 0; trace.push('child after'); }
      async function parent() { trace.push('parent'); const p = child(); trace.push('parent prefix'); await p; trace.push('parent after'); }
      const p = parent(); trace.push('root'); await p; return trace;
    `),
      ).toEqual(["parent", "child", "parent prefix", "root", "child after", "parent after"]);
    }),
  );

  it.effect("combinators return promises without blocking the synchronous prefix", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      let release = false;
      async function work() { await 0; release = true; return 4; }
      async function all() { return Promise.all([work(), 2]); }
      const p = all();
      const prefix = release;
      const settled = Promise.allSettled([Promise.reject('no')]);
      const race = Promise.race([Promise.resolve(3)]);
      return [prefix, p instanceof Promise, settled instanceof Promise, race instanceof Promise, await p, await settled, await race];
    `),
      ).toEqual([false, true, true, true, [4, 2], [{ status: "rejected", reason: "no" }], 3]);
    }),
  );

  it.effect("Array.from and sort do not await async callbacks", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const mapped = Array.from([1, 2], async n => { await 0; return n * 2; });
      const sorted = [3, 1, 2].sort(async (a, b) => a - b);
      return [mapped[0] instanceof Promise, await Promise.all(mapped), sorted];
    `),
      ).toEqual([true, [2, 4], [3, 1, 2]]);
    }),
  );

  it.effect("drains work admitted after an abandoned async activation resumes", () =>
    Effect.gen(function* () {
      const seen: number[] = [];
      const record = Tool.make({
        description: "Record",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow;
            seen.push(n);
            return n;
          }),
      });
      const result = yield* CodeMode.execute({
        tools: { record },
        code: `
      async function spawn(n) { await 0; tools.record(n); if (n < 3) spawn(n + 1); }
      spawn(1); return 'done';
    `,
      });
      expect(result.ok && result.value).toBe("done");
      expect(seen).toEqual([1, 2, 3]);
    }),
  );

  it.effect("async completion does not cancel fire-and-forget tools", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let completed = false;
      let interrupted = false;
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
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
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow },
          code: `async function f() { tools.slow(1); return 2; } return await f();`,
        }),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.ok && result.value).toBe(2);
      expect(completed).toBe(true);
      expect(interrupted).toBe(false);
    }),
  );

  it.effect("race cancels a losing async activation and its tool descendants", () =>
    Effect.gen(function* () {
      let active = 0;
      let interrupted = 0;
      const slow = Tool.make({
        description: "Never",
        input: Schema.Number,
        output: Schema.Number,
        run: () =>
          Effect.gen(function* () {
            active++;
            return yield* Effect.never;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                active--;
                interrupted++;
              }),
            ),
          ),
      });
      const result = yield* CodeMode.execute({
        tools: { slow },
        code: `
      let child;
      async function loser() { child = tools.slow(1); await tools.slow(2); return 0; }
      const winner = await Promise.race([loser(), 9]);
      const observed = await Promise.allSettled([child]);
      return [winner, observed[0].status];
    `,
      });
      expect(result.ok && result.value).toEqual([9, "rejected"]);
      expect(active).toBe(0);
      expect(interrupted).toBe(2);
    }),
  );

  it.effect("race cancels a losing combinator and its nested async tools", () =>
    Effect.gen(function* () {
      let interrupted = 0;
      const slow = Tool.make({
        description: "Never",
        input: Schema.Finite,
        output: Schema.Finite,
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
        code: `
      async function loser() { await tools.slow(1); }
      const group = Promise.all([loser(), tools.slow(2)]);
      return await Promise.race([group, 9]);
    `,
      });
      expect(result.ok && result.value).toBe(9);
      expect(interrupted).toBe(2);
    }),
  );

  it.effect("all rejects without waiting for an earlier unresolved input", () =>
    Effect.gen(function* () {
      let interrupted = 0;
      const slow = Tool.make({
        description: "Never",
        input: Schema.Finite,
        output: Schema.Finite,
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
        code: `
      try { await Promise.all([tools.slow(1), Promise.reject('fail')]); }
      catch (e) { return e; }
    `,
      });
      expect(result.ok && result.value).toBe("fail");
      expect(interrupted).toBe(1);
    }),
  );

  it.effect("replacer promise coercion does not hide unhandled rejection", () =>
    Effect.gen(function* () {
      for (const code of [
        `return 'a'.replace(/a/, async () => { await 0; throw new Error('replacer'); });`,
        `return 'a'.replaceAll('a', () => Promise.reject(new Error('replacer')));`,
        `async function f() { await 0; throw new Error('replacer'); } f(); return 1;`,
      ]) {
        const result = yield* CodeMode.execute({ tools: {}, code });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.message).toContain("replacer");
      }
    }),
  );

  it.effect("async activations share tool permits and lifecycle identifiers", () =>
    Effect.gen(function* () {
      const release = Deferred.makeUnsafe<void>();
      const full = Deferred.makeUnsafe<void>();
      const ids: number[] = [];
      let active = 0,
        maximum = 0;
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Finite,
        output: Schema.Finite,
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
          onToolCallLifecycle: (event) =>
            Effect.sync(() => {
              if (event.status === "queued") ids.push(event.id);
            }),
          code: `async function f(n) { await 0; return await tools.slow(n); } return await Promise.all(Array.from({length: 20}, (_, n) => f(n)));`,
        }),
      );
      yield* Deferred.await(full);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.ok && result.value).toEqual(Array.from({ length: 20 }, (_, n) => n));
      expect(maximum).toBe(8);
      expect(new Set(ids).size).toBe(20);
    }),
  );

  it.effect("host cancellation cleans up async descendants", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let interrupted = 0;
      const slow = Tool.make({
        description: "Never",
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
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow },
          code: `async function f() { await 0; return await tools.slow(1); } await f();`,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(interrupted).toBe(1);
    }),
  );

  it.live("execution timeout cleans up async descendants", () =>
    Effect.gen(function* () {
      let interrupted = 0;
      const slow = Tool.make({
        description: "Never",
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
        limits: { timeoutMs: 30 },
        code: `async function f() { await 0; return await tools.slow(1); } await f();`,
      });
      expect(!result.ok && result.error.kind).toBe("TimeoutExceeded");
      expect(interrupted).toBe(1);
    }),
  );
});
