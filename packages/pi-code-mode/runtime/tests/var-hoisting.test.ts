import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";

describe("function var environments", () => {
  it.effect(
    "hoists program vars and assigns catch-shadowed initializers to the catch parameter",
    () =>
      Effect.gen(function* () {
        const result = yield* CodeMode.execute({
          tools: {},
          code: `
        const before = x;
        var x = 1;
        let caught;
        try { throw 2; } catch (x) { var x = 3; caught = x; }
        return [typeof before, x, caught];
      `,
        });
        expect(result).toMatchObject({
          ok: true,
          value: ["undefined", 1, 3],
        });
      }),
  );
  it.effect("hoists unreachable vars without resetting existing bindings", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        function f(arg) {
          const before = typeof hidden;
          if (false) { var hidden = 1; }
          var arg;
          var value = 3; var value;
          return [before, arg, value, typeof tail];
          var tail = 4;
        }
        return f(9);
      `,
      });
      expect(result.ok && result.value).toEqual(["undefined", 9, 3, "undefined"]);
    }),
  );

  it.effect("keeps body vars out of parameter defaults and preserves default captures", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let outside = 7;
        function f(a = outside, capture = () => a) {
          var outside = 10;
          var a = 20;
          return [capture(), a, outside];
        }
        return f();
      `,
      });
      expect(result.ok && result.value).toEqual([7, 20, 10]);
    }),
  );

  it.effect("does not hoist nested-function vars into their caller", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        tools: {},
        code: `
        let x = 8;
        function outer() { function inner() { var x = 2; return x; } return [x, inner()]; }
        return outer();
      `,
      });
      expect(result.ok && result.value).toEqual([8, 2]);
    }),
  );
});
