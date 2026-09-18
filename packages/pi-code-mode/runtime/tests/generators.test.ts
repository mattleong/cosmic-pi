import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

describe("generator resumptions", () => {
  it.effect("initializes parameters at invocation but leaves bodies lazy", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
          const trace = [];
          function init() { trace.push('parameter'); return 7; }
          function* g(value = init()) { var value; trace.push('body'); yield value; }
          async function* a(value = init()) { trace.push('async body'); yield value; }
          const sync = g(), async = a();
          const before = trace.slice();
          let caught = false;
          function* bad(value = missing) { yield value; }
          try { bad(); } catch { caught = true; }
          return [before, caught, sync.next().value, (await async.next()).value, trace];
        `,
      });
      expect(result.ok && result.value).toEqual([
        ["parameter", "parameter"],
        true,
        7,
        7,
        ["parameter", "parameter", "body", "async body"],
      ]);
    }),
  );

  it.effect("closes a delegate missing throw and preserves a failing close", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
          const trace = [];
          function make(fail) {
            const delegate = {
              [Symbol.iterator]() { return delegate; },
              next() { return { value: 1, done: false }; },
              return() { trace.push('closed'); if (fail) throw 'close failed'; return { done: true }; }
            };
            return delegate;
          }
          function* g(fail) { yield* make(fail); }
          const a = g(false), b = g(true);
          a.next(); b.next();
          let first, second;
          try { a.throw(7); } catch(e) { first = e.name; }
          try { b.throw(7); } catch(e) { second = e; }
          return [trace, first, second, a.next().done, b.next().done];
        `,
      });
      expect(result.ok && result.value).toEqual([
        ["closed", "closed"],
        "TypeError",
        "close failed",
        true,
        true,
      ]);
    }),
  );

  it.effect(
    "delegates to native cursors and closes before first throw without entering the body",
    () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
          let entered = false;
          function* g() { entered = true; yield* [1, 2][Symbol.iterator](); }
          const unused = g();
          let caught;
          try { unused.throw('stop'); } catch (e) { caught = e; }
          const before = entered;
          const iterator = g();
          return [before, caught, unused.next().done, iterator.next(), iterator.next(), iterator.next().done];
        `,
        });
        expect(result.ok && result.value).toEqual([
          false,
          "stop",
          true,
          { value: 1, done: false },
          { value: 2, done: false },
          true,
        ]);
      }),
  );

  it.effect("is lazy, receives next input, and stays completed", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        function* g() { trace.push('start'); const sent = yield 1; return sent + 1; }
        const iterator = g(); const before = trace.length;
        const a = iterator.next(99), b = iterator.next(8), c = iterator.next();
        return [before, trace, a, b, c.done];
      `,
      });
      expect(result.ok && result.value).toEqual([
        0,
        ["start"],
        { value: 1, done: false },
        { value: 9, done: true },
        true,
      ]);
    }),
  );

  it.effect("suspends a pending return while finally yields", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        function* g() { try { yield 1; } finally { yield 2; } }
        const iterator = g();
        return [iterator.next(), iterator.return(9), iterator.next()];
      `,
      });
      expect(result.ok && result.value).toEqual([
        { value: 1, done: false },
        { value: 2, done: false },
        { value: 9, done: true },
      ]);
    }),
  );

  it.effect("injects throws at yield and delegates next and return values", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        function* child() { try { yield 1; } catch (e) { yield e; } return 4; }
        function* parent() { const value = yield* child(); return value + 1; }
        const iterator = parent();
        return [iterator.next(), iterator.throw('caught'), iterator.next()];
      `,
      });
      expect(result.ok && result.value).toEqual([
        { value: 1, done: false },
        { value: "caught", done: false },
        { value: 5, done: true },
      ]);
    }),
  );

  it.effect("permits nested generators but rejects a running generator resuming itself", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        function* child() { yield 3; }
        let iterator;
        function* parent() {
          let rejected = false;
          try { iterator.next(); } catch { rejected = true; }
          yield [rejected, child().next().value];
        }
        iterator = parent(); return iterator.next();
      `,
      });
      expect(result.ok && result.value).toEqual({ value: [true, 3], done: false });
    }),
  );

  it.effect("return before first next never enters the body", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let entered = false;
        function* g() { entered = true; yield 1; }
        const iterator = g(); const result = iterator.return(7);
        return [entered, result, iterator.next().done];
      `,
      });
      expect(result.ok && result.value).toEqual([false, { value: 7, done: true }, true]);
    }),
  );
});
