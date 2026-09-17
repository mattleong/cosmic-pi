import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { CodeMode } from "../src/index.js";
import { invokeJson } from "../src/interpreter/json.js";
import {
  CoercionFunction,
  type InterpreterArray,
  type InterpreterValue,
} from "../src/interpreter/model.js";
import { MAX_GUEST_STRING_LENGTH } from "../src/interpreter/confinement.js";
import { SandboxPromise, SandboxDate, SandboxMap } from "../src/values.js";

const run = (code: string) => CodeMode.execute({ code });
// Pure native reference operations for the fixed compatibility fixtures below.
const nativeStringify = (
  value: InterpreterValue,
  keys?: (string | number)[] | null,
  indent?: number,
) => JSON.stringify(value, keys, indent);
const nativeCallbacks = () => [
  Schema.decodeUnknownSync(Schema.String)(JSON.parse("1", String)),
  JSON.stringify([1, 2], JSON.stringify),
];
const direct = (args: InterpreterArray) =>
  invokeJson(
    "stringify",
    args,
    { type: "CallExpression" },
    () => () => Effect.succeed(undefined),
    () => {},
  );

describe("JSON helper preflight", () => {
  it.effect("preserves nonfinite property names and ignores boxed list entries", () =>
    Effect.gen(function* () {
      expect(
        yield* direct([
          { NaN: 1, Infinity: 2, 0: 3, "1970-01-01T00:00:00.000Z": 4 },
          [NaN, Infinity, -0, new SandboxDate(0)],
        ]),
      ).toBe('{"NaN":1,"Infinity":2,"0":3}');
      expect(yield* direct([{}, ["toString", "valueOf"]])).toBe("{}");
    }),
  );
  it.effect("bounds property-list work on opaque empty projections", () =>
    Effect.gen(function* () {
      const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`);
      for (const opaque of [new SandboxMap(), new SandboxPromise(undefined, Effect.succeed(1))]) {
        const values = Array.from({ length: 2500 }, () => opaque);
        expect(Exit.isFailure(yield* Effect.exit(direct([values, keys])))).toBe(true);
        expect(yield* direct([[opaque], keys])).toBe("[{}]");
      }
    }),
  );
  it.effect("refuses escaped output amplification and checks deadlines", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(direct(["\u0000".repeat(800000)])))).toBe(true);
      const result = yield* Effect.exit(
        invokeJson(
          "stringify",
          ["a".repeat(10000)],
          { type: "CallExpression" },
          () => () => Effect.succeed(undefined),
          () => {
            throw Error("deadline");
          },
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
  it.effect("keeps async reviver results opaque and deletes array slots bottom-up", () =>
    Effect.gen(function* () {
      const promise = new SandboxPromise(undefined, Effect.succeed(7));
      const keys: InterpreterArray = [];
      const result = yield* invokeJson(
        "parse",
        ["[1,2]", new CoercionFunction("String")],
        { type: "CallExpression" },
        () => (args) => {
          keys.push(args[0]);
          return Effect.succeed(args[0] === "0" ? undefined : args[0] === "1" ? promise : args[1]);
        },
        () => {},
      );
      expect(keys).toEqual(["0", "1", ""]);
      expect(Array.isArray(result) && result.length).toBe(2);
      expect(Array.isArray(result) && Object.hasOwn(result, 0)).toBe(false);
      expect(Array.isArray(result) && result[1]).toBe(promise);
      expect(yield* direct([promise])).toBe("{}");
    }),
  );
  it.effect("keeps numeric property-list order, deduplication, and nested array contents", () =>
    Effect.gen(function* () {
      const value = {
        2: "two",
        1: "one",
        child: { 1: 1, 2: 2, omit: 3 },
        array: [{ 1: 4, omit: 5 }, 6],
      };
      const keys = [2, "1", "2", true, {}, "child", "array"];
      expect(yield* direct([value, keys])).toBe(
        nativeStringify(value, [2, "1", "2", "child", "array"]),
      );
    }),
  );
  it.effect("does not materialize excluded branches", () =>
    Effect.gen(function* () {
      const excluded: InterpreterArray = [];
      excluded.push(excluded);
      expect(yield* direct([{ keep: 1, excluded }, ["keep"]])).toBe('{"keep":1}');
    }),
  );
  it.effect("matches native escaping and indentation at the exact output limit", () =>
    Effect.gen(function* () {
      const text = "a".repeat(MAX_GUEST_STRING_LENGTH - 2);
      const serialized = yield* direct([text]);
      expect(Predicate.isString(serialized) && serialized.length).toBe(MAX_GUEST_STRING_LENGTH);
      expect(yield* direct([{ quote: '\u0000\n"\\\ud800😀' }, null, 10])).toBe(
        nativeStringify({ quote: '\u0000\n"\\\ud800😀' }, null, 10),
      );
    }),
  );
  it.effect("invokes callbacks on original shallow values", () =>
    Effect.gen(function* () {
      const nested = { n: 1 };
      const value = { nested };
      const seen: InterpreterArray = [];
      const result = yield* invokeJson(
        "stringify",
        [value, new CoercionFunction("String")],
        { type: "CallExpression" },
        () => (args) => {
          seen.push(args[1]);
          return Effect.succeed(args[1]);
        },
        () => {},
      );
      expect(result).toBe('{"nested":{"n":1}}');
      expect(seen[0]).toBe(value);
      expect(seen[1]).toBe(nested);
    }),
  );
});

describe("JSON callbacks in guest programs", () => {
  it.effect("visits replacers top-down with a root key and original references", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const child = { n: 2 }; const value = { child, remove: 3, array: [1, 2] }; const keys = [];
      const text = JSON.stringify(value, (k, v) => { keys.push(k); if (k === "child" && v !== child) throw Error("copied");
        if (k === "remove" || k === "0") return undefined; return v; }); return { text, keys };`),
      ).toMatchObject({
        ok: true,
        value: {
          text: '{"child":{"n":2},"array":[null,2]}',
          keys: ["", "child", "n", "remove", "array", "0", "1"],
        },
      });
    }),
  );
  it.effect("accepts callable references as JSON callbacks", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`return [JSON.parse("1", String), JSON.stringify([1, 2], JSON.stringify)];`),
      ).toMatchObject({
        ok: true,
        value: nativeCallbacks(),
      });
    }),
  );

  it.effect("applies native Date and URL conversion before callbacks", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `return JSON.stringify({ date: new Date(0), url: new URL("https://example.com/") }, (k, v) => k === "date" || k === "url" ? typeof v + ":" + v : v);`,
        ),
      ).toMatchObject({
        ok: true,
        value: '{"date":"string:1970-01-01T00:00:00.000Z","url":"string:https://example.com/"}',
      });
    }),
  );
  it.effect("supports property-list projection and function omission without invoking toJSON", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const stringify = JSON.stringify; return [stringify({ 1: 1, 2: 2, list: [{ a: 1, b: 2 }, 7] }, [2,"1",2,"list","a",false]), stringify({ fn: () => 1, toJSON: () => 5 }), stringify([() => 1, undefined]), stringify(1, () => undefined) === undefined];`,
        ),
      ).toMatchObject({
        ok: true,
        value: ['{"2":2,"1":1,"list":[{"a":1},7]}', "{}", "[null,null]", true],
      });
    }),
  );
  it.effect("visits revivers bottom-up and deletes object and array members", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const keys = []; const result = JSON.parse('{"a":{"n":2},"drop":3,"list":[4,5]}', (k,v) => { keys.push(k); if (k === "drop" || k === "0") return undefined; return typeof v === "number" ? v * 2 : v; }); return { keys, result, hole: !(0 in result.list), length: result.list.length };`,
        ),
      ).toMatchObject({
        ok: true,
        value: {
          keys: ["n", "a", "drop", "0", "1", "list", ""],
          result: { a: { n: 4 }, list: [undefined, 10] },
          hole: true,
          length: 2,
        },
      });
      expect(yield* run(`return JSON.parse('1', () => undefined) === undefined;`)).toMatchObject({
        ok: true,
        value: true,
      });
    }),
  );
  it.effect("does not await stringify callbacks or parse reviver results", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const text = JSON.stringify({ a: 1 }, async (k,v) => v); const result = JSON.parse('{"a":1}', (k,v) => k === "a" ? Promise.resolve(7) : v); return [text, await result.a];`,
        ),
      ).toMatchObject({ ok: true, value: ["{}", 7] });
      expect(
        yield* run(`const result = JSON.parse('1', async (k,v) => v + 1); return await result;`),
      ).toMatchObject({ ok: true, value: 2 });
      expect(
        yield* run(
          `JSON.stringify(1, async () => { throw Error("unobserved JSON callback"); }); return 0;`,
        ),
      ).toMatchObject({ ok: false });
    }),
  );
  it.effect("rejects blocked properties and escaped output amplification", () =>
    Effect.gen(function* () {
      expect(yield* run(`return JSON.stringify({ a: 1 }, ["constructor"]);`)).toMatchObject({
        ok: false,
      });
      expect(yield* run(`return JSON.parse('{"__proto__":1}', (k,v) => v);`)).toMatchObject({
        ok: false,
      });
      expect(yield* run(`return JSON.stringify("\\u0000".repeat(800000));`)).toMatchObject({
        ok: false,
      });
      expect(yield* run(`return JSON.stringify({ a: 1 }, JSON.parse);`)).toMatchObject({
        ok: false,
      });
    }),
  );
});
