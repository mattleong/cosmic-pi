import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";
import { ToolRuntime } from "../src/tool-runtime.js";

// Runs a CodeMode program with no host tools and returns the CodeMode.Result. These tests pin the
// JS-parity behaviors for the "99% of ordinary defensive JavaScript just works" goal: cases where
// a strict interpreter would throw but idiomatic JS yields undefined / succeeds.
//
// Note on the result boundary: this package normalizes a bare `undefined` result to `null` when
// it crosses out of the sandbox (results are JSON data), so tests asserting an in-sandbox
// `undefined` read check `=== undefined` inside the program and `null` at the boundary.
const run = (code: string) => CodeMode.execute({ code, tools: {} });
const value = (code: string) =>
  Effect.map(run(code), (result) => {
    if (!result.ok)
      throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`);
    return result.value;
  });
const error = (code: string) =>
  Effect.map(run(code), (result) => {
    if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`);
    return result.error;
  });

describe("H2: string property access reads as undefined (not a throw)", () => {
  it.effect("unknown property on a string is undefined", () =>
    Effect.gen(function* () {
      expect(yield* value(`const s = "hi"; return s.login === undefined`)).toBe(true);
      expect(yield* value(`const s = "hi"; return s.login`)).toBeNull();
    }),
  );

  it.effect("optional chaining + fallback on a string does not throw", () =>
    Effect.gen(function* () {
      expect(yield* value(`const s = "hi"; return s?.login ?? "fallback"`)).toBe("fallback");
    }),
  );

  it.effect("the real MCP pattern: result is a JSON string, defensive read falls through", () =>
    Effect.gen(function* () {
      // me.result is a string; me.result?.login is undefined, so we fall back to the raw string.
      expect(
        yield* value(
          `const me = { result: '{"login":"x"}' }; return me.result?.login ?? me.result`,
        ),
      ).toBe('{"login":"x"}');
    }),
  );

  it.effect("unknown property on a number is undefined", () =>
    Effect.gen(function* () {
      expect(yield* value(`return (5).foo ?? "n"`)).toBe("n");
    }),
  );

  it.effect("supported string methods still work", () =>
    Effect.gen(function* () {
      expect(yield* value(`return "AB".toLowerCase()`)).toBe("ab");
      expect(yield* value(`return "hello".length`)).toBe(5);
    }),
  );
});

describe("H3: array property access reads as undefined (not a throw)", () => {
  it.effect("unknown property on an array is undefined", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1,2,3].foo === undefined`)).toBe(true);
      expect(yield* value(`return [1,2,3].foo`)).toBeNull();
    }),
  );

  it.effect("optional chaining on an array does not throw", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1,2,3]?.foo ?? "fb"`)).toBe("fb");
    }),
  );

  it.effect("unknown property reads stay undefined for methods CodeMode does not implement", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1,2,3].notAnArrayMethod === undefined`)).toBe(true);
    }),
  );

  it.effect("supported array methods and indexing still work", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1,2,3].map(x => x + 1)`)).toEqual([2, 3, 4]);
      expect(yield* value(`return [1,2,3][9] === undefined`)).toBe(true);
      expect(yield* value(`return [1,2,3][9]`)).toBeNull();
    }),
  );
});

describe("H6: object spread of null/undefined is a no-op", () => {
  it.effect("spreading null is a no-op", () =>
    Effect.gen(function* () {
      expect(yield* value(`const o = null; return { ...o, a: 1 }`)).toEqual({ a: 1 });
    }),
  );

  it.effect("spreading an absent argument merges cleanly", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`function f(opts){ return { ...opts, a: 1 } } return f(undefined)`),
      ).toEqual({ a: 1 });
    }),
  );

  it.effect("spreading a real object still works", () =>
    Effect.gen(function* () {
      expect(yield* value(`const o = { a: 1 }; return { ...o, b: 2 }`)).toEqual({ a: 1, b: 2 });
    }),
  );

  it.effect("spreading an array into an object still errors", () =>
    Effect.gen(function* () {
      const err = yield* error(`return { ...[1,2], a: 1 }`);
      expect(err.kind).toBe("InvalidDataValue");
    }),
  );
});

describe("H4: typeof on an undeclared identifier is 'undefined'", () => {
  it.effect("feature-detection guard does not throw", () =>
    Effect.gen(function* () {
      expect(yield* value(`return typeof foo === "undefined" ? "safe" : "no"`)).toBe("safe");
    }),
  );

  it.effect("typeof of a declared binding is unaffected", () =>
    Effect.gen(function* () {
      expect(yield* value(`const x = 5; return typeof x`)).toBe("number");
      expect(yield* value(`const s = "a"; return typeof s`)).toBe("string");
    }),
  );

  it.effect("referencing an undeclared identifier outside typeof still throws", () =>
    Effect.gen(function* () {
      const err = yield* error(`return foo + 1`);
      expect(err.message).toContain("foo");
    }),
  );
});

describe("H1: NaN/Infinity flow as intermediates and normalize to null at the boundary", () => {
  it.effect("guards run instead of the program crashing on a transient NaN", () =>
    Effect.gen(function* () {
      expect(yield* value(`return parseInt("abc") || 0`)).toBe(0);
      expect(yield* value(`const x = Number("abc"); return Number.isNaN(x) ? 0 : x`)).toBe(0);
      expect(yield* value(`const o = {}; o.count = (o.count || 0) + 1; return o.count`)).toBe(1);
      // average of an empty list, guarded - the classic divide-by-zero that used to throw pre-guard
      expect(
        yield* value(`const a = []; return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0`),
      ).toBe(0);
    }),
  );

  it.effect("a non-finite value becomes null when it leaves the sandbox", () =>
    Effect.gen(function* () {
      expect(yield* value(`return 5/0`)).toBeNull();
      expect(yield* value(`return 0/0`)).toBeNull();
      expect(yield* value(`return Math.max()`)).toBeNull();
      // nested, too - normalization walks the returned structure
      expect(yield* value(`return { a: Number("x"), b: 2, c: [1/0] }`)).toEqual({
        a: null,
        b: 2,
        c: [null],
      });
    }),
  );

  it.effect("NaN and Infinity are usable identifiers and inspectable in-sandbox", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Number.isNaN(NaN)`)).toBe(true);
      expect(yield* value(`return Infinity > 1e9`)).toBe(true);
      expect(yield* value(`return Number.isFinite(1/0)`)).toBe(false);
      expect(yield* value(`return [3,1,2].reduce((a,b)=>Math.max(a,b), -Infinity)`)).toBe(3);
      // JSON.stringify inside the sandbox matches JS: non-finite serializes to null
      expect(yield* value(`return JSON.stringify({ x: Number("z") })`)).toBe('{"x":null}');
    }),
  );

  it.effect(
    "copyOut normalizes non-finite numbers to null (the shared return + tool-arg boundary)",
    () =>
      Effect.sync(() => {
        // Tool-call arguments funnel through copyOut too, so this one function pins both boundaries.
        expect(ToolRuntime.copyOut(NaN)).toBeNull();
        expect(ToolRuntime.copyOut(Infinity)).toBeNull();
        expect(ToolRuntime.copyOut(-Infinity)).toBeNull();
        expect(ToolRuntime.copyOut(42)).toBe(42);
        expect(ToolRuntime.copyOut({ a: NaN, b: [Infinity, 1] })).toEqual({
          a: null,
          b: [null, 1],
        });
      }),
  );
});

describe("Error values and instanceof", () => {
  it.effect("new Error carries name/message and is instanceof Error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`const e = new Error("boom"); return [e instanceof Error, e.name, e.message]`),
      ).toEqual([true, "Error", "boom"]);
    }),
  );

  it.effect("Error without new behaves like new Error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`const e = Error("plain"); return [e instanceof Error, e.name, e.message]`),
      ).toEqual([true, "Error", "plain"]);
      expect(
        yield* value(`const e = new Error(); return [e.name, e.message, e instanceof Error]`),
      ).toEqual(["Error", "", true]);
    }),
  );

  it.effect("specific error types are instanceof themselves and Error, not each other", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const e = new TypeError("t"); return [e instanceof TypeError, e instanceof Error, e instanceof RangeError]`,
        ),
      ).toEqual([true, true, false]);
      expect(yield* value(`return new Error("e") instanceof TypeError`)).toBe(false);
    }),
  );

  it.effect("thrown errors keep instanceof through try/catch", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `try { throw new Error("x") } catch (e) { return [e instanceof Error, e.message] }`,
        ),
      ).toEqual([true, "x"]);
    }),
  );

  it.effect("interpreter runtime failures are caught as Error values", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`try { JSON.parse("nope") } catch (e) { return e instanceof Error }`),
      ).toBe(true);
      expect(yield* value(`try { undeclared() } catch (e) { return e instanceof Error }`)).toBe(
        true,
      );
    }),
  );

  it.effect("caught failures carry the constructor name the real-JS failure would have", () =>
    Effect.gen(function* () {
      // JSON.parse throws SyntaxError: name and specific-instanceof both carry through, and the
      // message keeps the engine's position detail.
      expect(
        yield* value(`
      try { JSON.parse("{oops") } catch (e) {
        return [e.name, e instanceof SyntaxError, e instanceof Error, e instanceof TypeError, e.message.includes("JSON")]
      }
    `),
      ).toEqual(["SyntaxError", true, true, false, true]);
      expect(
        yield* value(
          `try { undeclared() } catch (e) { return [e.name, e instanceof ReferenceError] }`,
        ),
      ).toEqual(["ReferenceError", true]);
      expect(
        yield* value(
          `try { const c = 1; c = 2 } catch (e) { return [e.name, e instanceof TypeError] }`,
        ),
      ).toEqual(["TypeError", true]);
      expect(
        yield* value(
          `try { "a".normalize("NOPE") } catch (e) { return [e.name, e instanceof RangeError] }`,
        ),
      ).toEqual(["RangeError", true]);
      expect(
        yield* value(
          `try { "a".match("(") } catch (e) { return [e.name, e instanceof SyntaxError] }`,
        ),
      ).toEqual(["SyntaxError", true]);
      expect(
        yield* value(
          `try { new RegExp("(") } catch (e) { return [e.name, e instanceof SyntaxError] }`,
        ),
      ).toEqual(["SyntaxError", true]);
    }),
  );

  it.effect("diagnostics without a specific real-JS analogue are named plain Error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`try { JSON.parse(5) } catch (e) { return [e.name, e instanceof Error] }`),
      ).toEqual(["Error", true]);
    }),
  );

  it.effect("Promise.allSettled rejection reasons are Error values", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const settled = await Promise.allSettled([Promise.reject(new Error("b"))])
      return [settled[0].reason instanceof Error, settled[0].reason.message]
    `),
      ).toEqual([true, "b"]);
    }),
  );

  it.effect("non-error thrown values are not instanceof Error", () =>
    Effect.gen(function* () {
      expect(yield* value(`try { throw "raw" } catch (e) { return e instanceof Error }`)).toBe(
        false,
      );
      expect(
        yield* value(`try { throw { message: "shaped" } } catch (e) { return e instanceof Error }`),
      ).toBe(false);
    }),
  );

  it.effect("plain data is never instanceof Error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`return [({}) instanceof Error, "s" instanceof Error, null instanceof Error]`),
      ).toEqual([false, false, false]);
    }),
  );

  it.effect("error values still serialize as plain { name, message } data", () =>
    Effect.gen(function* () {
      expect(yield* value(`return new Error("m")`)).toEqual({ name: "Error", message: "m" });
      expect(yield* value(`return JSON.stringify(new Error("m"))`)).toBe(
        '{"name":"Error","message":"m"}',
      );
      expect(
        yield* value(`try { throw new Error("m") } catch (e) { return Object.keys(e) }`),
      ).toEqual(["name", "message"]);
    }),
  );

  it.effect("spreading an error loses the brand, like losing the prototype in JS", () =>
    Effect.gen(function* () {
      expect(yield* value(`const e = new Error("m"); return ({ ...e }) instanceof Error`)).toBe(
        false,
      );
      expect(yield* value(`const e = new Error("m"); return { ...e }`)).toEqual({
        name: "Error",
        message: "m",
      });
    }),
  );

  it.effect(
    "typeof Error is function; an unknown instanceof right-hand side is a catchable error",
    () =>
      Effect.gen(function* () {
        expect(yield* value(`return typeof Error`)).toBe("function");
        expect(yield* value(`try { return 1 instanceof 5 } catch (e) { return "caught" }`)).toBe(
          "caught",
        );
        const err = yield* error(`return 1 instanceof 5`);
        expect(err.message).toContain("right-hand side of 'instanceof'");
      }),
  );
});

describe("array methods: splice, fill, copyWithin, keys/values/entries", () => {
  it.effect("splice removes in place and returns the removed elements", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`const a = [1,2,3,4]; const removed = a.splice(1, 2); return { removed, a }`),
      ).toEqual({
        removed: [2, 3],
        a: [1, 4],
      });
    }),
  );

  it.effect("splice inserts new elements at the cut", () =>
    Effect.gen(function* () {
      expect(yield* value(`const a = ["a","d"]; a.splice(1, 0, "b", "c"); return a`)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
      expect(
        yield* value(
          `const a = [1,2,3]; const removed = a.splice(1, 1, "x"); return { removed, a }`,
        ),
      ).toEqual({
        removed: [2],
        a: [1, "x", 3],
      });
    }),
  );

  it.effect("splice with one argument removes to the end; negative start counts back", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`const a = [1,2,3]; const removed = a.splice(1); return { removed, a }`),
      ).toEqual({
        removed: [2, 3],
        a: [1],
      });
      expect(
        yield* value(`const a = [1,2,3]; const removed = a.splice(-1); return { removed, a }`),
      ).toEqual({
        removed: [3],
        a: [1, 2],
      });
    }),
  );

  it.effect("splice rejects inserting a container into itself", () =>
    Effect.gen(function* () {
      const err = yield* error(`const a = [1]; a.splice(0, 0, [a]); return a`);
      expect(err.kind).toBe("InvalidDataValue");
      expect(err.message).toContain("circular");
    }),
  );

  it.effect("fill overwrites a range and returns the mutated array", () =>
    Effect.gen(function* () {
      expect(yield* value(`const a = [1,2,3,4]; return a.fill(0, 1, 3)`)).toEqual([1, 0, 0, 4]);
      expect(yield* value(`return [1,2,3].fill("z")`)).toEqual(["z", "z", "z"]);
    }),
  );

  it.effect("copyWithin copies a range in place", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1,2,3,4,5].copyWithin(0, 3)`)).toEqual([4, 5, 3, 4, 5]);
    }),
  );

  it.effect("keys/values/entries return arrays usable with for...of and spread", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [...["x","y","z"].keys()]`)).toEqual([0, 1, 2]);
      expect(yield* value(`return ["x","y"].values()`)).toEqual(["x", "y"]);
      expect(
        yield* value(`
      const out = []
      for (const [index, item] of ["a","b"].entries()) out.push(index + ":" + item)
      return out
    `),
      ).toEqual(["0:a", "1:b"]);
      expect(yield* value(`return [...[7].entries()]`)).toEqual([[0, 7]]);
    }),
  );
});

describe("string methods: localeCompare, normalize, trim aliases", () => {
  it.effect("localeCompare orders strings for sorting", () =>
    Effect.gen(function* () {
      expect(yield* value(`return ["b","a","c"].sort((x, y) => x.localeCompare(y))`)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(yield* value(`return "a".localeCompare("a")`)).toBe(0);
    }),
  );

  it.effect("normalize applies unicode normalization forms", () =>
    Effect.gen(function* () {
      expect(yield* value(`return "\\u0065\\u0301".normalize("NFC").length`)).toBe(1);
      expect(yield* value(`return "\\u00e9".normalize("NFD").length`)).toBe(2);
      expect(yield* value(`return "x".normalize() === "x"`)).toBe(true);
    }),
  );

  it.effect("an invalid normalize form is a clear catchable error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`try { "x".normalize("nope"); return "no" } catch (e) { return e.message }`),
      ).toContain('"NFC"');
    }),
  );

  it.effect("trimLeft/trimRight alias trimStart/trimEnd", () =>
    Effect.gen(function* () {
      expect(yield* value(`return "  x ".trimLeft()`)).toBe("x ");
      expect(yield* value(`return "  x ".trimRight()`)).toBe("  x");
    }),
  );
});

describe("compound assignment matches its binary operator", () => {
  // `x op= y` must behave exactly like `x = x op y`, sharing the binary operator's coercion
  // semantics (Dates string-coerce for `+` and use their time value for arithmetic; data
  // objects/arrays coerce to their JS string form).
  const pair = (compound: string, expanded: string) =>
    Effect.map(Effect.all([value(compound), value(expanded)]), ([a, b]) => {
      expect(a).toEqual(b);
      return a;
    });

  it.effect("sandbox Date += concatenates its string form, like d = d + 1", () =>
    Effect.gen(function* () {
      const result = yield* pair(
        `let d = new Date(1000); d += 1; return d`,
        `let d = new Date(1000); d = d + 1; return d`,
      );
      expect(result).toBe("1970-01-01T00:00:01.000Z1");
    }),
  );

  it.effect("sandbox Date numeric compound ops use its time value", () =>
    Effect.gen(function* () {
      expect(
        yield* pair(
          `let d = new Date(1000); d -= 400; return d`,
          `let d = new Date(1000); d = d - 400; return d`,
        ),
      ).toBe(600);
      expect(
        yield* pair(
          `let d = new Date(1000); d /= 4; return d`,
          `let d = new Date(1000); d = d / 4; return d`,
        ),
      ).toBe(250);
    }),
  );

  it.effect("string += object/array matches x = x + obj", () =>
    Effect.gen(function* () {
      expect(
        yield* pair(
          `let x = "a"; x += { b: 1 }; return x`,
          `let x = "a"; x = x + { b: 1 }; return x`,
        ),
      ).toBe("a[object Object]");
      expect(
        yield* pair(`let x = "a"; x += [1, 2]; return x`, `let x = "a"; x = x + [1, 2]; return x`),
      ).toBe("a1,2");
    }),
  );

  it.effect("compound assignment through a member target coerces the same way", () =>
    Effect.gen(function* () {
      expect(
        yield* pair(
          `const o = { s: "t" }; o.s += new Date(0); return o.s`,
          `const o = { s: "t" }; o.s = o.s + new Date(0); return o.s`,
        ),
      ).toBe("t1970-01-01T00:00:00.000Z");
    }),
  );

  it.effect("numeric and string compound operators sweep identically to their expansions", () =>
    Effect.gen(function* () {
      const cases: Array<[string, number | string]> = [
        [`let x = 7; x += 3; return x`, 7 + 3],
        [`let x = 7; x -= 3; return x`, 7 - 3],
        [`let x = 7; x *= 3; return x`, 7 * 3],
        [`let x = 7; x /= 2; return x`, 7 / 2],
        [`let x = 7; x %= 3; return x`, 7 % 3],
        [`let x = 7; x **= 2; return x`, 7 ** 2],
        [`let x = 7; x &= 3; return x`, 7 & 3],
        [`let x = 7; x |= 8; return x`, 7 | 8],
        [`let x = 7; x ^= 2; return x`, 7 ^ 2],
        [`let x = 7; x <<= 2; return x`, 7 << 2],
        [`let x = -7; x >>= 1; return x`, -7 >> 1],
        [`let x = -7; x >>>= 1; return x`, -7 >>> 1],
        [`let x = "a"; x += "b"; return x`, "ab"],
      ];
      for (const [compound, expected] of cases) {
        expect(yield* value(compound)).toBe(expected);
        expect(yield* value(compound.replace(/x (\S+)= /, (_, op) => `x = x ${op} `))).toBe(
          expected,
        );
      }
    }),
  );
});

describe("H5: builtin coercion functions work as array callbacks", () => {
  it.effect("filter(Boolean) drops falsy values", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [0, 1, "", 2, null, 3].filter(Boolean)`)).toEqual([1, 2, 3]);
    }),
  );

  it.effect("map(String) coerces each element", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1, 2, 3].map(String)`)).toEqual(["1", "2", "3"]);
    }),
  );

  it.effect("arrow callbacks still work (no regression)", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [1, 2, 3, 4].filter(x => x % 2 === 0)`)).toEqual([2, 4]);
      expect(yield* value(`return [1, 2, 3].reduce((a, b) => a + b, 0)`)).toBe(6);
    }),
  );

  it.effect("a non-callable callback is still rejected", () =>
    Effect.gen(function* () {
      const err = yield* error(`return [1,2,3].map(42)`);
      expect(err.message).toContain("callback");
    }),
  );
});
