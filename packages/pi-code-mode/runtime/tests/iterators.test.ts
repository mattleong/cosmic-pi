import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

const source = `
  function range() {
    let n = 0;
    return { [Symbol.iterator]: () => ({ next: () => ({ value: ++n, done: n > 3 }) }) };
  }
`;

describe("confined iterator protocol", () => {
  it.effect("retains materialized collection methods beside explicit native cursors", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
          const cursor = [4, 5][Symbol.iterator]();
          return [
            [4, 5].values().map(x => x + 1),
            new Map([["a", 1]]).entries(),
            new Set([2]).keys(),
            new URLSearchParams("x=3").values(),
            cursor.next(), cursor.next(), cursor.next()
          ];
        `,
      });
      expect(result.ok && result.value).toEqual([
        [5, 6],
        [["a", 1]],
        [2],
        ["3"],
        { value: 4, done: false },
        { value: 5, done: false },
        { done: true, value: null },
      ]);
    }),
  );
  it.effect("consumes closure iterators through spread, from, and destructuring", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code:
          source +
          `
        const [first, ...rest] = range();
        return [[...range()], Array.from(range(), x => x * 2), first, rest];
      `,
      });
      expect(result.ok && result.value).toEqual([[1, 2, 3], [2, 4, 6], 1, [2, 3]]);
    }),
  );

  it.effect("consumes generators through constructors, grouping, and promise combinators", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
          function* numbers() { yield 1; yield 2; yield 1; }
          function* pairs() { yield ['a', 1]; yield ['b', 2]; }
          return [
            Object.fromEntries(pairs()), new Map(pairs()).entries(),
            new Set(numbers()).values(), new URLSearchParams(pairs()).toString(),
            Object.groupBy(numbers(), x => String(x)),
            await Promise.all(numbers()), await Promise.allSettled(numbers()),
            await Promise.any(numbers()), await Promise.race(numbers())
          ];
        `,
      });
      expect(result.ok && result.value).toEqual([
        { a: 1, b: 2 },
        [
          ["a", 1],
          ["b", 2],
        ],
        [1, 2],
        "a=1&b=2",
        { "1": [1, 1], "2": [2] },
        [1, 2, 1],
        [
          { status: "fulfilled", value: 1 },
          { status: "fulfilled", value: 2 },
          { status: "fulfilled", value: 1 },
        ],
        1,
        1,
      ]);
    }),
  );

  it.effect("closes fromEntries on invalid entries without consuming the next value", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
          const trace = [];
          function* pairs() {
            try { yield ['a', 1]; yield 4; trace.push('continued'); }
            finally { trace.push('closed'); }
          }
          try { Object.fromEntries(pairs()); } catch (error) { trace.push('caught'); }
          return trace;
        `,
      });
      expect(result.ok && result.value).toEqual(["closed", "caught"]);
    }),
  );

  it.effect("closes on break, partial destructuring, and body throw", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let closed = 0;
        function source() { return { [Symbol.iterator]: () => ({
          next: () => ({value: 1, done: false}),
          return: () => { closed++; return {done: true}; }
        }) }; }
        for (const x of source()) { break; }
        const [first] = source();
        let caught;
        try { for (const x of source()) throw 'body'; } catch (e) { caught = e; }
        return [closed, first, caught];
      `,
      });
      expect(result.ok && result.value).toEqual([3, 1, "body"]);
    }),
  );

  it.effect("captures next once but looks up return when closing", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = []; let n = 0;
        const iterator = {next: () => ({value: ++n, done: false}), return: () => { throw 'stale'; }};
        const source = {[Symbol.iterator]: () => iterator};
        for (const value of source) {
          trace.push(value);
          iterator.next = () => { throw 'replaced'; };
          iterator.return = () => { trace.push('closed'); return {done: true}; };
          if (value === 2) break;
        }
        return trace;
      `,
      });
      expect(result.ok && result.value).toEqual([1, 2, "closed"]);
    }),
  );

  it.effect("does not close on exhaustion, same-loop continue, or next failure", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let closed = 0, n = 0;
        const source = {[Symbol.iterator]: () => ({
          next: () => ({value: ++n, done: n > 2}),
          return: () => { closed++; return {done: true}; }
        })};
        for (const value of source) { continue; }
        const broken = {[Symbol.iterator]: () => ({
          next: () => { throw 'next'; }, return: () => { closed++; return {done: true}; }
        })};
        let caught;
        try { for (const value of broken) {} } catch (e) { caught = e; }
        return [closed, n, caught];
      `,
      });
      expect(result.ok && result.value).toEqual([0, 3, "next"]);
    }),
  );

  it.effect("preserves the body throw when iterator close also throws", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const source = { [Symbol.iterator]: () => ({
          next: () => ({value: 1, done: false}), return: () => { throw 'close'; }
        }) };
        try { for (const x of source) throw 'body'; } catch (e) { return e; }
      `,
      });
      expect(result.ok && result.value).toBe("body");
    }),
  );
});
