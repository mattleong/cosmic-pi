import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

describe("destructuring assignments and computed bindings", () => {
  it.effect("supports swaps, nested defaults, rest and the assignment result", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
      let a = 1, b = 2, tail, nested; [a, b] = [b, a];
      const source = [{x: undefined}, 4, 5];
      const result = [{x: nested = a + b}, ...tail] = source;
      return [a, b, nested, tail, result === source];
    `,
      });
      expect(result).toMatchObject({ ok: true, value: [2, 1, 3, [4, 5], true] });
    }),
  );

  it.effect(
    "evaluates computed keys once and excludes normalized numeric and symbol keys from rest",
    () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
      let count = 0; function key() { count++; return 1; }
      const input = {1: 9, other: 2, [Symbol.iterator]: 7};
      const {[key()]: declared, [Symbol.iterator]: symbol, ...declRest} = input;
      let assigned, assignedSymbol, rest;
      ({[key()]: assigned, [Symbol.iterator]: assignedSymbol, ...rest} = input);
      return [declared, symbol, assigned, assignedSymbol, count, Object.keys(rest), Object.keys(declRest), rest[Symbol.iterator]];
    `,
        });
        expect(result).toMatchObject({
          ok: true,
          value: [9, 7, 9, 7, 2, ["other"], ["other"], null],
        });
      }),
  );

  it.effect("resolves object targets before reads and copies unconsumed symbol keys", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const source = {x: 1, [Symbol.iterator]: 7}, box = {}, trace = [];
        function key() { trace.push('key'); return 'x'; }
        function target() { trace.push('target'); source.x = 9; return box; }
        function restTarget() { trace.push('rest'); source.extra = 3; return box; }
        ({[key()]: target().x, ...restTarget().rest} = source);
        return [box.x, box.rest.extra, box.rest[Symbol.iterator], trace];
      `,
      });
      expect(result).toMatchObject({ ok: true, value: [9, 3, 7, ["key", "target", "rest"]] });
    }),
  );

  it.effect("ignores values on exhausted iterator results and still runs defaults", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let x, y;
        const values = {[Symbol.iterator]: () => ({next: () => ({done: true, value: 99})})};
        [x = 2, y = 3] = values;
        const [a = 4] = values;
        return [x, y, a];
      `,
      });
      expect(result).toMatchObject({ ok: true, value: [2, 3, 4] });
    }),
  );

  it.effect("resolves member targets before iterator steps and defaults, exactly once", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
      const trace = [], box = {};
      const iterable = {[Symbol.iterator]: () => ({next: () => {trace.push('next'); return {done: false, value: undefined};}, return: () => {trace.push('close'); return {done: true};}})};
      function target() { trace.push('target'); return box; }
      function key() { trace.push('key'); return 'x'; }
      function fallback() { trace.push('default'); return 8; }
      [target()[key()] = fallback()] = iterable;
      return [box.x, trace];
    `,
      });
      expect(result).toMatchObject({
        ok: true,
        value: [8, ["target", "key", "next", "default", "close"]],
      });
    }),
  );

  it.effect(
    "closes on failed writes, preserves the original throw, and reports normal close failures",
    () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
      let closed = 0, caught = [], x;
      const values = {[Symbol.iterator]: () => ({next: () => ({done: false, value: 1}), return: () => {closed++; throw 'close';}})};
      const fixed = 0;
      try { [fixed] = values; } catch (e) { caught.push(e instanceof TypeError); }
      try { [x] = values; } catch (e) { caught.push(e); }
      try { [x = missing] = [undefined]; } catch (e) { caught.push(e instanceof ReferenceError); }
      return [closed, caught, x];
    `,
        });
        expect(result).toMatchObject({ ok: true, value: [2, [true, "close", true], 1] });
      }),
  );

  for (const target of ["null.x", "null[key()]", "target().x", "box[throwKey()]"]) {
    it.effect(`matches native iterator close timing for failed target ${target}`, () =>
      Effect.gen(function* () {
        const code = `
          const trace = [], box = {};
          const values = {[Symbol.iterator]: () => ({
            next: () => { trace.push('next'); return {done: false, value: undefined}; },
            return: () => { trace.push('close'); return {done: true}; }
          })};
          function key() { trace.push('key'); return 'x'; }
          function target() { trace.push('target'); throw 'target'; }
          function throwKey() { trace.push('key'); throw 'key'; }
          function fallback() { trace.push('default'); return 1; }
          try { [${target} = fallback()] = values; } catch (e) { trace.push('caught'); }
          return trace;
        `;
        const native = new Function(`"use strict"; ${code}`)();
        expect(native).toEqual(
          target === "null.x"
            ? ["next", "default", "close", "caught"]
            : target === "null[key()]"
              ? ["key", "next", "default", "close", "caught"]
              : [target === "target().x" ? "target" : "key", "close", "caught"],
        );
        expect(yield* CodeMode.execute({ code })).toMatchObject({ ok: true, value: native });
      }),
    );
  }

  it.effect("blocked target keys intentionally close before consuming an iterator value", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
          const trace = [], box = {};
          const values = {[Symbol.iterator]: () => ({
            next: () => { trace.push('next'); return {done: false, value: 1}; },
            return: () => { trace.push('close'); return {done: true}; }
          })};
          try { [box['constructor']] = values; } catch (e) { trace.push('caught'); }
          return trace;
        `,
      });
      expect(result).toMatchObject({ ok: true, value: ["close", "caught"] });
    }),
  );

  it.effect("does not close when the iterator itself throws", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
      let closed = 0, x, caught;
      const values = {[Symbol.iterator]: () => ({next: () => {throw 'next';}, return: () => {closed++; return {done: true};}})};
      try { [x] = values; } catch (e) { caught = e; }
      return [closed, caught];
    `,
      });
      expect(result).toMatchObject({ ok: true, value: [0, "next"] });
    }),
  );

  for (const code of [
    "const x = 1; [x] = [2];",
    "[x] = [2]; let x;",
    "let x; ({['constructor']: x} = {});",
    "const {['__proto__']: x} = {};",
    "let {[x]: y} = {}; let x = 'a';",
  ])
    it.effect(`retains binding and blocked-key guards: ${code}`, () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({ tools: {}, code });
        expect(result.ok).toBe(false);
      }),
    );

  it.effect("host interruption does not execute guest IteratorClose", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let cleanup = 0;
      const slow = Tool.make({
        description: "Wait",
        input: Schema.Number,
        output: Schema.Number,
        run: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
      });
      const close = Tool.make({
        description: "Observe cleanup",
        input: Schema.Number,
        output: Schema.Number,
        run: (n) =>
          Effect.sync(() => {
            cleanup++;
            return n;
          }),
      });
      const fiber = yield* Effect.forkChild(
        CodeMode.execute({
          tools: { slow, close },
          code: `
      let x;
      const values = {[Symbol.iterator]: () => ({next: () => ({done: false, value: undefined}), return: () => {tools.close(1); return {done: true};}})};
      [x = await tools.slow(1)] = values;
    `,
        }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(cleanup).toBe(0);
    }),
  );
});
