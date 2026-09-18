import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

describe("lexical initialization", () => {
  for (const code of [
    "let x = 1; { return x; let x = 2; }",
    "{ return typeof x; let x; }",
    "let [x = x] = []; return x;",
    "let {x = y, y = 2} = {}; return x;",
    "switch (0) { case 0: return x; case 1: let x = 2; }",
    "let x = [1]; for (let x of x) {}",
    "let y = 7; try { throw {}; } catch ({x = y, y = 2}) {}",
    "let x = 7; try { throw []; } catch ([x = x]) {}",
  ]) {
    it.effect(`rejects access before initialization: ${code}`, () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({ tools: {}, code });
        expect(result.ok).toBe(false);
      }),
    );
  }

  it.effect("keeps unknown typeof and initialized destructuring distinct from TDZ", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let [a = 2, b = a + 1] = [];
        let {c = b} = {};
        return [typeof missing, a, b, c];
      `,
      });
      expect(result.ok && result.value).toEqual(["undefined", 2, 3, 3]);
    }),
  );

  it.effect(
    "keeps initializer, test, body and update captures in their specified environments",
    () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
        const initial = [], tests = [], bodies = [], updates = [];
        for (let i = 0, saved = initial.push(() => i);
          (tests.push(() => i) && i < 2);
          (updates.push(() => i) && i++)) {
          bodies.push(() => i);
        }
        return [initial.map(f => f()), tests.map(f => f()), bodies.map(f => f()), updates.map(f => f())];
      `,
        });
        expect(result).toMatchObject({
          ok: true,
          value: [[0], [0, 1, 2], [0, 1], [1, 2]],
        });
      }),
  );

  it.effect("captures the outer environment when evaluating a switch discriminant", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let x = 7, capture;
        switch ((capture = () => x) && 0) { case 0: let x = 2; break; }
        return capture();
      `,
      });
      expect(result).toMatchObject({ ok: true, value: 7 });
    }),
  );

  it.effect("restores block, catch, loop and switch scopes after guest failures", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let x = 9;
        try { for (let x = 0; x < 1; x++) { switch (x) { case 0: let y = 1; throw y; } } }
        catch (x) { try { let x = 3; throw x; } catch (y) {} }
        return [x, typeof y];
      `,
      });
      expect(result.ok && result.value).toEqual([9, "undefined"]);
    }),
  );

  it.effect("captures separate counted-loop and for-of iteration bindings", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        const counted = [], items = [];
        for (let i = 0; i < 3; i++) counted.push(() => i);
        for (const item of [4, 5, 6]) items.push(() => item);
        return [counted.map(f => f()), items.map(f => f())];
      `,
      });
      expect(result.ok && result.value).toEqual([
        [0, 1, 2],
        [4, 5, 6],
      ]);
    }),
  );
});
