import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

describe("async generator requests", () => {
  it.effect("runs an idle request synchronously until its first await or yield", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
          const trace = [];
          async function* g() { trace.push('start'); yield 1; trace.push('resume'); await 0; trace.push('awaited'); yield 2; }
          const iterator = g();
          const first = iterator.next(); trace.push('caller');
          await first;
          const second = iterator.next(); trace.push('caller again');
          await second;
          return trace;
        `,
      });
      expect(result.ok && result.value).toEqual([
        "start",
        "caller",
        "resume",
        "caller again",
        "awaited",
      ]);
    }),
  );

  it.effect("continues queued requests after a throw closes the body", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
          async function* g() { yield 1; throw 'failed'; }
          const iterator = g();
          const first = iterator.next();
          const failed = iterator.next().catch(e => e);
          const last = iterator.next();
          return [await first, await failed, (await last).done, await iterator.return(Promise.resolve(5))];
        `,
      });
      expect(result.ok && result.value).toEqual([
        { value: 1, done: false },
        "failed",
        true,
        { value: 5, done: true },
      ]);
    }),
  );

  it.effect("adopts return arguments before entering finally and catches rejected yields", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
          const trace = [];
          async function* g() {
            try { yield Promise.reject('yield rejection'); }
            catch (e) { trace.push(e); yield 1; }
            finally { trace.push('finally'); yield 2; }
          }
          const fresh = g();
          const closed = await fresh.return(Promise.resolve(7));
          const iterator = g();
          const first = await iterator.next();
          const cleanup = await iterator.return(Promise.resolve(9));
          const last = await iterator.next();
          return [closed, first, cleanup, last, trace];
        `,
      });
      expect(result.ok && result.value).toEqual([
        { value: 7, done: true },
        { value: 1, done: false },
        { value: 2, done: false },
        { value: 9, done: true },
        ["yield rejection", "finally"],
      ]);
    }),
  );

  it.effect("queues distinct requests and adopts yielded promises", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        async function* g() { trace.push('start'); const input = yield Promise.resolve(1); yield input; return 3; }
        const iterator = g(); const lazy = trace.length;
        const a = iterator.next(), b = iterator.next(2), c = iterator.next();
        return [lazy, a !== b, await Promise.all([a, b, c]), trace];
      `,
      });
      expect(result.ok && result.value).toEqual([
        0,
        true,
        [
          { value: 1, done: false },
          { value: 2, done: false },
          { value: 3, done: true },
        ],
        ["start"],
      ]);
    }),
  );

  it.effect("queues return through a yielding finally", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        async function* g() { try { yield 1; } finally { await 0; yield 2; } }
        const iterator = g();
        const a = iterator.next(), b = iterator.return(9), c = iterator.next();
        return await Promise.all([a, b, c]);
      `,
      });
      expect(result.ok && result.value).toEqual([
        { value: 1, done: false },
        { value: 2, done: false },
        { value: 9, done: true },
      ]);
    }),
  );

  it.effect("forwards throw through asynchronous yield delegation", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        async function* child() { try { yield 1; } catch (e) { yield e; } return 4; }
        async function* parent() { return yield* child(); }
        const iterator = parent();
        return [await iterator.next(), await iterator.throw('caught'), await iterator.next()];
      `,
      });
      expect(result.ok && result.value).toEqual([
        { value: 1, done: false },
        { value: "caught", done: false },
        { value: 4, done: true },
      ]);
    }),
  );
});
