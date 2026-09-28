// Local JavaScript compatibility fixes; see PROVENANCE.md.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool, toolError } from "../src/index.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
} from "../src/interpreter/confinement.js";

const run = (code: string) => CodeMode.execute({ code });
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

describe("object helper integration", () => {
  it.effect("assign mutates and returns its target while preserving shallow references", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const nested = { value: 1 }; const target = { old: true };
        const result = Object.assign(target, { nested, value: 1 }, null, undefined, { value: 2 });
        nested.value = 3;
        return { same: result === target, nestedSame: target.nested === nested,
          value: target.value, nestedValue: result.nested.value, old: target.old,
          selfAssign: Object.assign(target, target) === target };`),
      ).toMatchObject({
        ok: true,
        value: {
          same: true,
          nestedSame: true,
          value: 2,
          nestedValue: 3,
          old: true,
          selfAssign: true,
        },
      });
      expect(
        yield* run(`const target = []; const nested = { value: 1 };
        const result = Object.assign(target, [nested]);
        return [target === result, target[0] === nested, target.length];`),
      ).toMatchObject({ ok: true, value: [true, true, 1] });
    }),
  );

  it.effect("refuses cyclic insertions without installing the offending member", () =>
    Effect.gen(function* () {
      for (const incoming of ["target", "{ ref: target }"]) {
        expect(
          yield* run(`const target = {}; let caught = false;
          try { Object.assign(target, { ok: 1 }, { loop: ${incoming} }); }
          catch { caught = true; }
          return { caught, ok: target.ok, installed: Object.hasOwn(target, "loop") };`),
        ).toMatchObject({ ok: true, value: { caught: true, ok: 1, installed: false } });
      }
      for (const args of ["", "null", "undefined", "1", "new Map()"])
        expect(
          yield* run(`try { Object.assign(${args}); return false; } catch { return true; }`),
        ).toMatchObject({ ok: true, value: true });
    }),
  );

  it.effect("array values, entries, and own-property checks preserve holes and identity", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const item = { value: 1 }; const a = [item, , "last"];
        const values = Object.values(a); const entries = Object.entries(a);
        return { valuesSame: values[0] === item, entriesSame: entries[0][1] === item,
          keys: entries.map(pair => pair[0]), count: values.length,
          first: Object.hasOwn(a, 0), hole: Object.hasOwn(a, 1), length: Object.hasOwn(a, "length") };`),
      ).toMatchObject({
        ok: true,
        value: {
          valuesSame: true,
          entriesSame: true,
          keys: ["0", "2"],
          count: 2,
          first: true,
          hole: false,
          length: true,
        },
      });
      expect(
        yield* run(`const item = {}; const source = { item };
        return [Object.values(source)[0] === item, Object.entries(source)[0][1] === item];`),
      ).toMatchObject({ ok: true, value: [true, true] });
    }),
  );
});

describe("mutating array methods", () => {
  it.effect("join charges separators for holes and admits exact-fit joins", () =>
    Effect.gen(function* () {
      expect(yield* run('return [, , ,].join("x".repeat(3000000)).length;')).toMatchObject({
        ok: false,
      });
      expect(
        yield* run(`return [, , ,].join("x".repeat(${MAX_GUEST_STRING_LENGTH / 2})).length;`),
      ).toMatchObject({ ok: true, value: MAX_GUEST_STRING_LENGTH });
      expect(
        yield* run(`return ["only"].join("x".repeat(${MAX_GUEST_STRING_LENGTH}));`),
      ).toMatchObject({ ok: true, value: "only" });
    }),
  );

  it.effect("reverse and sort return the original array and update aliases", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = [3, 1, 2]; const alias = a;
        const reversed = a.reverse(); const reverseValue = a.slice();
        const sorted = a.sort((a, b) => a - b);
        return { reverseSame: reversed === a, sortSame: sorted === a,
          reverseValue, alias };`),
      ).toMatchObject({
        ok: true,
        value: {
          reverseSame: true,
          sortSame: true,
          reverseValue: [2, 1, 3],
          alias: [1, 2, 3],
        },
      });
      expect(
        yield* run(`const a = [3, 1, 2]; const b = a.toSorted(); const c = a.toReversed();
        return { a, b, c, distinct: a !== b && a !== c };`),
      ).toMatchObject({
        ok: true,
        value: { a: [3, 1, 2], b: [1, 2, 3], c: [2, 1, 3], distinct: true },
      });
    }),
  );

  it.effect("preserves sparse holes in mutations and densifies copying variants", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = [, , undefined, , 1];
        a.sort(); const sortedKeys = Object.keys(a); a.reverse();
        return { length: a.length, sortedKeys, reversedKeys: Object.keys(a),
          denseSortedKeys: Object.keys(a.toSorted()), denseReversedKeys: Object.keys(a.toReversed()) };`),
      ).toMatchObject({
        ok: true,
        value: {
          length: 5,
          sortedKeys: ["0", "1"],
          reversedKeys: ["3", "4"],
          denseSortedKeys: ["0", "1", "2", "3", "4"],
          denseReversedKeys: ["0", "1", "2", "3", "4"],
        },
      });
    }),
  );

  it.effect(
    "sort skips undefined comparisons, retains appended elements, and contains throws",
    () =>
      Effect.gen(function* () {
        expect(
          yield* run(`const a = [undefined, 2, 1]; let sawUndefined = false;
        a.sort((left, right) => {
          sawUndefined = sawUndefined || left === undefined || right === undefined;
          a.push(9); return left - right;
        }); return { a, sawUndefined };`),
        ).toMatchObject({ ok: true, value: { a: [1, 2, null, 9], sawUndefined: false } });
        expect(
          yield* run(`const a = [2, 1]; let caught = false;
        try { a.sort(() => { throw new Error("bad comparator"); }); } catch { caught = true; }
        return { a, caught };`),
        ).toMatchObject({ ok: true, value: { a: [2, 1], caught: true } });
      }),
  );

  it.effect("sort validates write-back after a comparator changes the object graph", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const item = { n: 2 }; const a = [item, { n: 1 }]; let caught = false;
        try { a.sort((left, right) => {
          a.splice(0); item.parent = a; return left.n - right.n;
        }); } catch { caught = true; }
        return { caught, length: a.length, linked: item.parent === a };`),
      ).toMatchObject({ ok: true, value: { caught: true, length: 0, linked: true } });
    }),
  );
});

describe("split and toSpliced compatibility", () => {
  it.effect("split treats omitted and undefined separators alike and normalizes the limit", () =>
    Effect.gen(function* () {
      for (const limit of ["undefined", "1", "-1", "4294967297"])
        expect(yield* run(`return "abc".split(undefined, ${limit});`)).toMatchObject({
          ok: true,
          value: ["abc"],
        });
      for (const limit of ["0", "NaN", "Infinity", "0.5", "4294967296"])
        expect(yield* run(`return "abc".split(undefined, ${limit});`)).toMatchObject({
          ok: true,
          value: [],
        });
      expect(yield* run('return ["abc".split(), "abc".split(undefined)];')).toMatchObject({
        ok: true,
        value: [["abc"], ["abc"]],
      });
    }),
  );

  it.effect("toSpliced handles argument omission, numeric normalization, and removal", () =>
    Effect.gen(function* () {
      const cases = [
        { args: "", value: [1, 2, 3] },
        { args: "undefined", value: [] },
        { args: "1", value: [1] },
        { args: "1, undefined", value: [1, 2, 3] },
        { args: "1, 1, 9", value: [1, 9, 3] },
        { args: "-1, Infinity, 9", value: [1, 2, 9] },
        { args: "Infinity, 1, 9", value: [1, 2, 3, 9] },
        { args: "-Infinity, 1, 9", value: [9, 2, 3] },
        { args: "NaN, NaN, 9", value: [9, 1, 2, 3] },
        { args: "1.9, 1.9, 9", value: [1, 9, 3] },
      ];
      for (const { args, value } of cases)
        expect(
          yield* run(`const a = [1, 2, 3]; const b = a.toSpliced(${args});
          return { a, b, distinct: a !== b };`),
        ).toMatchObject({ ok: true, value: { a: [1, 2, 3], b: value, distinct: true } });
    }),
  );

  it.effect("toSpliced produces dense shallow copies and can insert the original array", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const item = {}; const a = [item, , 3]; const b = a.toSpliced(2, 1, a);
        return { sameItem: b[0] === item, insertedOriginal: b[2] === a,
          keys: Object.keys(b), originalKeys: Object.keys(a), holeIsUndefined: b[1] === undefined };`),
      ).toMatchObject({
        ok: true,
        value: {
          sameItem: true,
          insertedOriginal: true,
          keys: ["0", "1", "2"],
          originalKeys: ["0", "2"],
          holeIsUndefined: true,
        },
      });
    }),
  );

  it.effect("toSpliced admits exact-cap replacement and refuses growth before allocation", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = Array.from({ length: ${MAX_GUEST_COLLECTION_ENTRIES} });
        const b = a.toSpliced(0, 1, 7); let refused = false;
        try { a.toSpliced(0, 0, 7); } catch { refused = true; }
        return { originalLength: a.length, resultLength: b.length, first: b[0], refused };`),
      ).toMatchObject({
        ok: true,
        value: {
          originalLength: MAX_GUEST_COLLECTION_ENTRIES,
          resultLength: MAX_GUEST_COLLECTION_ENTRIES,
          first: 7,
          refused: true,
        },
      });
    }),
  );
});

describe("replacement patterns", () => {
  it.effect("expand $ patterns exactly like native String.prototype.replace", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, RegExp | string, string]> = [
        ["a-b-c", /-/g, "[$&|$`|$']"],
        ["red-blue", /(red)-(blue)/, "$2-$1"],
        ["abc", /(b)/, "$0 $1 $01 $10 $2 $$ $ $x"],
        ["abcdefghijk", /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, "$11-$10-$1"],
        ["2024-06", /(?<year>\d+)-(?<month>\d+)/, "$<month>/$<year> $<none> $<open"],
        ["ab", /(a)|(b)/g, "[$1$2]"],
        ["ab", /a/, "$<name>"],
        ["aXbXc", "X", "<$&$`$'>"],
        ["aXbXc", "X", "$1$<g>$$"],
        ["abc", "", "-$`-"],
        ["", /(?:)/g, "$'$`$&"],
        ["tail$", /l/, "L$"],
      ];
      for (const [subject, pattern, template] of cases) {
        // The guest evaluates the same literal pattern the host expectation uses.
        const source = pattern instanceof RegExp ? String(pattern) : quote(pattern);
        for (const method of ["replace", "replaceAll"] as const) {
          if (method === "replaceAll" && pattern instanceof RegExp && !pattern.global) continue;
          const expected = subject[method](pattern, template);
          expect(
            yield* run(`return ${quote(subject)}.${method}(${source}, ${quote(template)});`),
          ).toMatchObject({ ok: true, value: expected });
        }
      }
    }),
  );
});

describe("string and key conversion", () => {
  it.effect("errors convert to text the way Error.prototype.toString does", () =>
    Effect.gen(function* () {
      const failing = Tool.make({
        description: "Fail",
        input: Schema.Struct({}),
        output: Schema.String,
        run: () => Effect.fail(toolError("nope")),
      });
      expect(
        yield* CodeMode.execute({
          tools: { host: { failing } },
          code: `let caught;
          try { await tools.host.failing({}); } catch (error) { caught = error; }
          const typed = new TypeError("bad");
          const renamed = new Error(""); renamed.name = "Custom";
          const unnamed = new Error("only message"); unnamed.name = "";
          return [\`\${caught}\`, "x: " + caught, String(caught), caught.toString(),
            [caught, typed].join(" | "), String([typed]), \`\${renamed}\`, \`\${unnamed}\`];`,
        }),
      ).toMatchObject({
        ok: true,
        value: [
          "Error: nope",
          "x: Error: nope",
          "Error: nope",
          "Error: nope",
          "Error: nope | TypeError: bad",
          "TypeError: bad",
          "Custom",
          "only message",
        ],
      });
    }),
  );

  it.effect("objects and arrays answer toString and hasOwnProperty unless they own the name", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const o = { a: 1 };
        const shadow = { toString: 5 };
        return [o.toString(), o.hasOwnProperty("a"), o.hasOwnProperty("b"), [1, [2, 3]].toString(),
          shadow.toString, Object.keys(o)];`),
      ).toMatchObject({ ok: true, value: ["[object Object]", true, false, "1,2,3", 5, ["a"]] });
    }),
  );

  it.effect("property keys convert primitives and data values to strings", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const counts = {};
        for (const owner of ["a", null, undefined, true, "a", null]) counts[owner] = (counts[owner] || 0) + 1;
        const byList = {}; byList[[1, 2]] = "pair";
        return [counts, byList["1,2"], null in counts];`),
      ).toMatchObject({
        ok: true,
        value: [{ a: 2, null: 2, undefined: 1, true: 1 }, "pair", true],
      });
    }),
  );

  it.effect("only canonical index strings address array and string elements", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = ["x", "y"]; return [a["1"], a["01"], "hello"["01"], "hello"["1"]];`),
      ).toMatchObject({ ok: true, value: ["y", null, null, "e"] });
    }),
  );
});

describe("array callback iteration", () => {
  it.effect("skips holes, reads elements live, and passes the array itself", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const sparse = []; sparse[0] = 1; sparse[2] = 3;
        let calls = 0; sparse.forEach(() => calls++);
        const trimmed = [" x ", " y "]; trimmed.forEach((v, i, a) => { a[i] = v.trim(); });
        const live = [1, 2, 3]; const seen = live.map((v, i, a) => { if (i === 0) a[2] = 30; return v; });
        const grown = [1, 2]; const visited = []; grown.forEach((v, i, a) => { a.push(v); visited.push(v); });
        const one = [1]; const same = one.map((v, i, a) => a === one)[0];
        let caught; try { [].reduce((a, b) => a + b); } catch (e) { caught = e instanceof TypeError; }
        return [sparse.reduce((s, x) => s + x, 0), calls, sparse.reduce((s, x) => s + x),
          sparse.map((x) => x * 2).length, 1 in sparse.map((x) => x), sparse.filter(() => true),
          sparse.findIndex((x) => x === undefined), trimmed, seen, visited, grown.length, same, caught];`),
      ).toMatchObject({
        ok: true,
        value: [4, 2, 4, 3, false, [1, 3], 1, ["x", "y"], [1, 2, 30], [1, 2], 4, true, true],
      });
    }),
  );
});

describe("shallow Object helpers", () => {
  it.effect("objects holding promises and functions work with Object helpers", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const tasks = { a: Promise.resolve(1), b: (async () => 2)() };
        const table = { add: (a, b) => a + b, mul: (a, b) => a * b };
        const merged = Object.assign({}, tasks, { c: Promise.resolve(3) });
        return [await Promise.all(Object.values(merged)), Object.keys(tasks),
          Object.entries(table).map(([name, fn]) => name + "=" + fn(2, 3)),
          Object.fromEntries([["f", () => 1]]).f()];`),
      ).toMatchObject({ ok: true, value: [[1, 2, 3], ["a", "b"], ["add=5", "mul=6"], 1] });
    }),
  );
});

describe("locale-aware comparison", () => {
  it.effect("localeCompare honors locales and collator options", () =>
    Effect.gen(function* () {
      const expected = [
        ["item10", "item9", "item1"].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        ),
        "a".localeCompare("A", undefined, { sensitivity: "base" }),
        "ä".localeCompare("z", "sv"),
      ];
      expect(
        yield* run(`return [
          ["item10", "item9", "item1"].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
          "a".localeCompare("A", undefined, { sensitivity: "base" }),
          "ä".localeCompare("z", "sv"),
        ];`),
      ).toMatchObject({ ok: true, value: expected });
      expect(
        yield* run(`return "a".localeCompare("b", undefined, { sensitivity: "loose" });`),
      ).toMatchObject({ ok: false });
    }),
  );
});

describe("common syntax", () => {
  it.effect("supports comma, void, delete, isNaN/isFinite, and numeric updates on dates", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const counts = {};
        for (const w of ["a", "b", "a"]) (counts[w] = (counts[w] || 0) + 1, counts);
        let i = 0, j = 5; for (; i < j; i++, j--);
        const o = { a: 1, b: 2 }; const deleted = delete o.a;
        const list = [1, 2, 3]; delete list[1];
        const missing = null;
        let when = new Date(5); when++;
        return [counts, i, j, void 0, deleted, o, list.length, 1 in list, delete missing?.x,
          isNaN("x"), isFinite("5"), when];`),
      ).toMatchObject({
        ok: true,
        value: [{ a: 2, b: 1 }, 3, 2, null, true, { b: 2 }, 3, false, true, true, true, 6],
      });
    }),
  );

  it.effect("named function expressions see their own name; destructuring reads like members", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const factorial = function me(n) { return n <= 1 ? 1 : n * me(n - 1); };
        const { length } = [1, 2, 3];
        const { 0: first, ...others } = ["x", "y"];
        const { hostname } = new URL("https://example.com/a");
        const { max } = Math;
        return [factorial(5), typeof me, length, first, others, hostname, max(1, 2)];`),
      ).toMatchObject({
        ok: true,
        value: [120, "undefined", 3, "x", { 1: "y" }, "example.com", 2],
      });
    }),
  );
});

describe("built-in lookup", () => {
  it.effect("the in operator, lastIndex, match input, statics, and constructors follow JS", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const m = new Map(); const d = new Date(0);
        const re = /a/g; re.exec("aa"); const advanced = re.lastIndex; re.lastIndex = 0;
        const match = "xay".match(/a/);
        const E = Error;
        const bytes = [...new Uint8Array(2)[Symbol.iterator]()];
        return ["map" in m, "size" in m, "get" in m, "time" in d, "getTime" in d, 1 in [1],
          "toString" in {}, advanced, re.lastIndex, match.input, typeof Math.nope,
          typeof Math.max, new E("boom").stack, bytes];`),
      ).toMatchObject({
        ok: true,
        value: [
          false,
          true,
          true,
          false,
          true,
          false,
          true,
          1,
          0,
          "xay",
          "undefined",
          "function",
          "Error: boom",
          [0, 0],
        ],
      });
      for (const code of ["{ const Map = 5; return new Map(); }", "return new Number(1);"])
        expect(yield* run(code)).toMatchObject({ ok: false });
    }),
  );
});

describe("sorting and flattening", () => {
  it.effect("default sort puts undefined last and flat skips holes", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const sparse = [1, , [2, , 3]];
        return [["x", undefined, "z", "a"].sort(), sparse.flat(), [3, undefined, 1].toSorted()];`),
      ).toMatchObject({
        ok: true,
        value: [
          ["a", "x", "z", null],
          [1, 2, 3],
          [1, 3, null],
        ],
      });
    }),
  );
});
