// Local JavaScript compatibility fixes; see PROVENANCE.md.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
} from "../src/interpreter/confinement.js";

const run = (code: string) => CodeMode.execute({ code });

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
