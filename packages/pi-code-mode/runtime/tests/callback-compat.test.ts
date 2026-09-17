import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

const run = (code: string) => CodeMode.execute({ code });

describe("shared callable callbacks", () => {
  it.effect("matches native global callbacks and their positional arguments", () =>
    Effect.gen(function* () {
      const result = yield* run(`return {
        mapped: Array.from([-2, 3], Math.abs),
        rounded: [-1.8, 2.8].map(Math.floor),
        powers: [2, 3, 4].map(Math.pow),
        json: [{ n: 1 }, { n: 2 }].map(JSON.stringify),
        from: Array.from(["10", "10", "10"], parseInt).map(String),
        filtered: [1, 1.5, 2].filter(Number.isInteger),
        found: [1.5, 2].find(Number.isInteger),
        index: [1.5, 2].findIndex(Number.isInteger),
        last: [1, 2.5, 3].findLast(Number.isInteger),
        lastIndex: [1, 2.5, 3].findLastIndex(Number.isInteger),
        some: [1.5, 2].some(Number.isInteger),
        every: [1, 2].every(Number.isInteger),
        flat: [[1], [2]].flatMap(Array.isArray),
        reduced: [1, 2, 3].reduce(Number.isInteger),
        right: [1, 2, 3].reduceRight(Number.isInteger)
      };`);
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        value: {
          mapped: [-2, 3].map(Math.abs),
          rounded: [-1.8, 2.8].map(Math.floor),
          powers: [2, 3, 4].map(Math.pow),
          json: ['{"n":1}', '{"n":2}'],
          from: Array.from(["10", "10", "10"], parseInt).map(String),
          filtered: [1, 1.5, 2].filter(Number.isInteger),
          found: 2,
          index: 1,
          last: 3,
          lastIndex: 2,
          some: true,
          every: true,
          flat: [true, true],
          reduced: false,
          right: false,
        },
      });
    }),
  );

  it.effect("still validates consumed Math arguments", () =>
    Effect.gen(function* () {
      for (const code of [
        "return Math.floor({});",
        "return Math.pow(2, {});",
        "return [1].map(Math.max);",
      ])
        expect(yield* run(code)).toMatchObject({ ok: false });
    }),
  );

  it.effect("accepts captured intrinsic callbacks without losing their receiver", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const seen = new Set();
        [1, 2].forEach(seen.add);
        new Map([["a", 3]]).forEach(seen.add);
        new Set([4]).forEach(seen.add);
        new URLSearchParams("a=5").forEach(seen.add);
        const member = { n: 1 };
        const lookup = new Map([[1, member]]);
        return { seen: Array.from(seen), same: [1].map(lookup.get)[0] === member,
          mapped: Array.from([1], lookup.get)[0] === member,
          replaced: "xy".replaceAll(/./g, "ab".toUpperCase) };`),
      ).toMatchObject({
        ok: true,
        value: { seen: [1, 2, 3, 4, "5"], same: true, mapped: true, replaced: "ABAB" },
      });
    }),
  );

  it.effect("supports global and error-constructor replacements", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`return {
        one: "ab".replace(/a/, Array.of),
        all: "ab".replaceAll(/./g, Array.of),
        errors: ["a", "b"].map(TypeError).map(e => e.message),
        errorText: "a".replace("a", Error)
      };`),
      ).toMatchObject({
        ok: true,
        value: {
          one: "ab".replace(/a/, (...args) => String(Array.of(...args))),
          all: "ab".replaceAll(/./g, (...args) => String(Array.of(...args))),
          errors: ["a", "b"],
          errorText: "[object Object]",
        },
      });
    }),
  );

  it.effect("accepts callable comparators and retains in-place identity", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = [3, 1, 2]; const same = a.sort(Number.isNaN) === a;
        return { same, a, copy: a.toSorted(Number.isNaN),
          coercion: a.toSorted(Boolean), uri: a.toSorted(encodeURIComponent) };`),
      ).toMatchObject({
        ok: true,
        value: { same: true, a: [3, 1, 2], copy: [3, 1, 2], coercion: [2, 1, 3], uri: [2, 1, 3] },
      });
    }),
  );

  it.effect("keeps promise callbacks unawaited until explicitly consumed", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const item = { n: 1 };
        const mapped = [item].map(Promise.resolve);
        const from = Array.from([item], Promise.resolve);
        const sorted = [3, 1, 2].toSorted(Promise.resolve);
        return { same: await mapped[0] === item, from: await from[0] === item,
          sorted, filtered: [0, 1].filter(Promise.resolve),
          replaced: "aa".replaceAll("a", Promise.resolve) };`),
      ).toMatchObject({
        ok: true,
        value: {
          same: true,
          from: true,
          sorted: [3, 1, 2],
          filtered: [0, 1],
          replaced: "[object Promise][object Promise]",
        },
      });
    }),
  );

  it.effect("dispatches tool callbacks without bypassing their argument guard", () =>
    Effect.gen(function* () {
      const echo = Tool.make({
        description: "Echo an index",
        input: Schema.Struct({ index: Schema.Number }),
        output: Schema.Number,
        run: ({ index }) => Effect.succeed(index),
      });
      expect(
        yield* CodeMode.execute({
          tools: { echo },
          code: `return await Promise.all([{ index: 1 }, { index: 2 }].map(tools.echo));`,
        }),
      ).toMatchObject({ ok: false, error: { kind: "InvalidToolInput" }, toolCalls: [] });
    }),
  );

  it.effect("rejects noncallables even for empty inputs", () =>
    Effect.gen(function* () {
      for (const code of [
        "[].map({})",
        "Array.from([], {})",
        "[].sort({})",
        "new Map().forEach({})",
        "new Set().forEach({})",
        "new URLSearchParams().forEach({})",
        "[].map(tools)",
      ]) {
        expect(yield* run(`return ${code};`)).toMatchObject({ ok: false });
      }
    }),
  );
});
