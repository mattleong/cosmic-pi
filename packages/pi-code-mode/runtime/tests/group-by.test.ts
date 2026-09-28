import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CodeMode } from "../src/index.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
} from "../src/interpreter/confinement.js";
import { makeRootActivation } from "../src/interpreter/activation.js";
import { invokeGroupBy } from "../src/interpreter/group-by.js";
import { CoercionFunction, type AstNode } from "../src/interpreter/model.js";
import { SandboxSet, SandboxDate, SandboxPromise } from "../src/values.js";
import { coerceToString } from "../src/interpreter/conversions.js";

const run = (code: string) => CodeMode.execute({ code });
// Grouping drives its source through a real activation; callbacks stay injected.
const activation = () =>
  makeRootActivation<never>({ admitTool: () => Effect.die("no tools"), toolKeys: () => [] });

describe("groupBy", () => {
  it.effect("groups iterable values with value/index callbacks and shallow references", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`
        const member = { n: 1 };
        const group = Object.groupBy;
        const values = group([member, member], (v, i, ...rest) => i + rest.length);
        values[0][0].n = 7;
        return { same: values[0][0] === member && values[1][0] === member,
          n: member.n, holes: group([, 2], v => String(v)),
          unicode: group("a😀", (_, i) => i),
          set: group(new Set([1, 2]), Number),
          map: group(new Map([["a", 1]]), ([k]) => k),
          params: group(new URLSearchParams("a=1&a=2"), ([k]) => k) };
      `),
      ).toMatchObject({
        ok: true,
        value: {
          same: true,
          n: 7,
          holes: { undefined: [null], "2": [2] },
          unicode: { "0": ["a"], "1": ["😀"] },
          set: { "1": [1], "2": [2] },
          map: { a: [["a", 1]] },
          params: {
            a: [
              ["a", "1"],
              ["a", "2"],
            ],
          },
        },
      });
    }),
  );

  it.effect("keeps opaque entries, Map key identity, SameValueZero and promise keys", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`
        const key = {}; const fn = () => 3; const p = Promise.resolve(5);
        const objects = Map.groupBy([fn, p], () => key);
        const numbers = Map.groupBy([NaN, NaN, -0, 0], v => v);
        const pending = Map.groupBy([1, 2], async v => v);
        return { identity: objects.get(key)[0] === fn && objects.get(key)[1] === p,
          nan: numbers.get(NaN).length, zero: numbers.get(0).length,
          normalized: 1 / Array.from(numbers.keys())[1] === Infinity,
          promises: pending.size, values: await Promise.all(pending.keys()) };
      `),
      ).toMatchObject({
        ok: true,
        value: {
          identity: true,
          nan: 2,
          zero: 2,
          normalized: true,
          promises: 2,
          values: [1, 2],
        },
      });
    }),
  );

  it.effect("accepts intrinsic callbacks and coerces async Object keys without awaiting", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`
        const json = Object.groupBy([{ n: 1 }, { n: 1 }], JSON.stringify);
        const pending = Object.groupBy([1, 2], async v => v);
        return [Object.values(json)[0].length, Object.keys(pending), pending["[object Promise]"]];
      `),
      ).toMatchObject({ ok: true, value: [2, ["[object Promise]"], [1, 2]] });
      expect(
        yield* run(`Object.groupBy([1], async () => { throw "unobserved"; }); return 1;`),
      ).toMatchObject({ ok: false });
    }),
  );

  it.effect("observes live array and collection mutations", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`
        const array = [1]; const set = new Set([1]);
        const a = Object.groupBy(array, v => { if (v === 1) array.push(2); return "a"; });
        const s = Map.groupBy(set, v => { if (v === 1) set.add(2); return "s"; });
        return [a.a, s.get("s")];
      `),
      ).toMatchObject({
        ok: true,
        value: [
          [1, 2],
          [1, 2],
        ],
      });
    }),
  );

  it.effect("rejects array-like sources and keeps prototype names as ordinary group keys", () =>
    Effect.gen(function* () {
      for (const code of [
        'return Object.groupBy({0: "a", length: 1}, String)',
        "return Map.groupBy([1], 4)",
      ])
        expect(yield* run(code)).toMatchObject({ ok: false });
      expect(
        yield* run('return Map.groupBy([1], () => "__proto__").get("__proto__")'),
      ).toMatchObject({ ok: true, value: [1] });
      expect(
        yield* run(`const byName = Object.groupBy([1, 2], (n) => n === 1 ? "__proto__" : "constructor");
          return [byName["__proto__"], byName.constructor];`),
      ).toMatchObject({ ok: true, value: [[1], [2]] });
    }),
  );

  it.effect("bounds visited entries before callbacks despite a constant-size live source", () =>
    Effect.gen(function* () {
      const source = new SandboxSet();
      source.set.add(0);
      let callbacks = 0;
      const result = yield* Effect.exit(
        invokeGroupBy(
          "Map",
          [source, new CoercionFunction("String")],
          { type: "CallExpression" },
          (_, args) =>
            Effect.sync(() => {
              callbacks += 1;
              source.set.delete(args[0]);
              source.set.add(callbacks);
              return "same";
            }),
          () => {},
          activation(),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(callbacks).toBe(MAX_GUEST_COLLECTION_ENTRIES);
    }),
  );

  it.effect("charges wrapped values before allocating oversized grouping keys", () =>
    Effect.gen(function* () {
      const date = new SandboxDate(0);
      const promise = SandboxPromise.settled(Exit.succeed(1));
      for (const key of [
        Array.from({ length: 180_000 }, () => date),
        Array.from({ length: MAX_GUEST_COLLECTION_ENTRIES }, () => promise),
      ]) {
        const result = yield* Effect.exit(
          invokeGroupBy(
            "Object",
            [[1], new CoercionFunction("String")],
            { type: "CallExpression" },
            () => Effect.succeed(key),
            () => {},
            activation(),
          ),
        );
        expect(result._tag).toBe("Failure");
      }
      expect(coerceToString(["x".repeat(MAX_GUEST_STRING_LENGTH)]).length).toBe(
        MAX_GUEST_STRING_LENGTH,
      );
    }),
  );

  it.effect("preflights source size and deadline before invoking callbacks", () =>
    Effect.gen(function* () {
      let callbacks = 0;
      const invoke = () =>
        Effect.sync(() => {
          callbacks += 1;
          return "a";
        });
      const node: AstNode = { type: "CallExpression" };
      const callback = new CoercionFunction("String");
      const oversized = yield* Effect.exit(
        invokeGroupBy(
          "Object",
          [Array.from({ length: MAX_GUEST_COLLECTION_ENTRIES + 1 }), callback],
          node,
          invoke,
          () => {},
          activation(),
        ),
      );
      const expired = yield* Effect.exit(
        invokeGroupBy(
          "Object",
          [[1], callback],
          node,
          invoke,
          () => {
            throw new Error("deadline");
          },
          activation(),
        ),
      );
      expect(oversized._tag).toBe("Failure");
      expect(expired._tag).toBe("Failure");
      expect(callbacks).toBe(0);
      const result = yield* invokeGroupBy(
        "Object",
        [[1], callback],
        node,
        invoke,
        () => {},
        activation(),
      );
      expect(Object.getPrototypeOf(result)).toBe(null);
    }),
  );
});
