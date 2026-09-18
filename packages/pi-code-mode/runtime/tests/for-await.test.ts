import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

describe("for await protocol", () => {
  it.effect(
    "preserves a body throw over close rejection but lets close rejection replace break",
    () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
        const trace = [];
        const source = { [Symbol.asyncIterator]: () => ({
          next: async () => ({done: false, value: 1}),
          return: async () => { await 0; trace.push('close'); throw 'closing'; }
        }) };
        try { for await (const x of source) { throw 'body'; } } catch (error) { trace.push(error); }
        try { for await (const x of source) { break; } } catch (error) { trace.push(error); }
        return trace;
      `,
        });
        expect(result).toMatchObject({
          ok: true,
          value: ["close", "body", "close", "closing"],
        });
      }),
  );

  it.effect("does not execute iterator return or guest finally on host interruption", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let cleanupCalls = 0;
      const wait = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
      });
      const cleanup = Tool.make({
        description: "Observe cleanup",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.sync(() => {
            cleanupCalls++;
            return n;
          }),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { wait, cleanup },
          code: `
        const source = { [Symbol.asyncIterator]: () => ({
          next: async () => ({done: false, value: 1}),
          return: async () => { await tools.cleanup(1); return {done: true}; }
        }) };
        try { for await (const x of source) { await tools.wait(x); } }
        finally { await tools.cleanup(2); }
      `,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(cleanupCalls).toBe(0);
    }),
  );
  it.effect("adopts sync iterator promises but retains async iterator value promises", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const values = [];
        for await (const x of [Promise.resolve(3)]) values.push(x);
        let consumed = false;
        const source = { [Symbol.asyncIterator]: () => ({ next: async () => {
          if (consumed) return {done: true};
          consumed = true; return {done: false, value: Promise.resolve(4)};
        } }) };
        for await (const x of source) values.push([x instanceof Promise, await x]);
        return values;
      `,
      });
      expect(result).toMatchObject({ ok: true, value: [3, [true, 4]] });
    }),
  );

  it.effect("awaits async iterator close before leaving a labeled loop", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const trace = [];
        const source = { [Symbol.asyncIterator]: () => ({
          next: async () => ({done: false, value: 1}),
          return: async () => { await 0; trace.push('closed'); return {done: true}; }
        }) };
        outer: for (let i = 0; i < 1; i++) {
          for await (const x of source) { trace.push(x); break outer; }
        }
        trace.push('after'); return trace;
      `,
      });
      expect(result).toMatchObject({
        ok: true,
        value: [1, "closed", "after"],
      });
    }),
  );
});
