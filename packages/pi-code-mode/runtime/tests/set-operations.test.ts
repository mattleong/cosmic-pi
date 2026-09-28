import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";
import { MAX_GUEST_COLLECTION_ENTRIES } from "../src/interpreter/confinement.js";
import { ExecutionDeadline, setDeadlineClockForTesting } from "../src/interpreter/deadline.js";
import { invokeSetOperation } from "../src/interpreter/set-operations.js";
import type { SetOperation } from "../src/interpreter/set-operations.js";
import type { InterpreterValue } from "../src/interpreter/model.js";
import { SandboxMap, SandboxSet } from "../src/values.js";

const set = (...values: InterpreterValue[]): SandboxSet => {
  const result = new SandboxSet();
  for (const value of values) result.set.add(value);
  return result;
};
const invoke = (left: SandboxSet, name: SetOperation, right: InterpreterValue) =>
  invokeSetOperation(left, name, right, new ExecutionDeadline(undefined));
const values = (value: SandboxSet | boolean) => {
  if (!(value instanceof SandboxSet)) throw new Error("Expected a Set");
  return [...value.set];
};
const operations: SetOperation[] = [
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
];

describe("confined Set operations", () => {
  it.effect("exposes all operations in guest programs and preserves opaque member identity", () =>
    Effect.gen(function* () {
      expect(
        yield* CodeMode.execute({
          code: `
        const left = new Set([3, 2, 1]); const right = new Map([[1, "a"], [3, "b"]]);
        const fn = () => 1; const key = {}; const opaque = new Set([fn, key]);
        const copied = opaque.union(new Set([key]));
        return [Array.from(left.union(right)), Array.from(left.intersection(right)),
          Array.from(left.difference(right)), Array.from(left.symmetricDifference(right)),
          left.isSubsetOf(right), left.isSupersetOf(right), left.isDisjointFrom(right),
          copied !== opaque, copied.has(fn), Array.from(copied, value => value)[1] === key,
          Array.from(left), Array.from(right.keys())];
      `,
        }),
      ).toMatchObject({
        ok: true,
        value: [
          [3, 2, 1],
          [1, 3],
          [2],
          [2],
          false,
          true,
          false,
          true,
          true,
          true,
          [3, 2, 1],
          [1, 3],
        ],
      });
      expect(
        yield* CodeMode.execute({
          code: `
        let calls = 0;
        const custom = { size: 0, has: () => { calls++; return false; }, keys: () => { calls++; return []; } };
        try { new Set().union(custom); } catch (error) { return [error instanceof TypeError, calls]; }
        return false;
      `,
        }),
      ).toMatchObject({ ok: true, value: [true, 0] });
    }),
  );
  it("preserves native order and leaves both operands unchanged", () => {
    const left = set(3, 2, 1);
    const right = set(1, 3, 4);
    expect(values(invoke(left, "union", right))).toEqual([3, 2, 1, 4]);
    expect(values(invoke(left, "intersection", right))).toEqual([3, 1]);
    expect(values(invoke(left, "intersection", set(1, 3)))).toEqual([1, 3]);
    expect(values(invoke(left, "difference", right))).toEqual([2]);
    expect(values(invoke(left, "difference", set(3)))).toEqual([2, 1]);
    expect(values(invoke(left, "symmetricDifference", right))).toEqual([2, 4]);
    expect([...left.set]).toEqual([3, 2, 1]);
    expect([...right.set]).toEqual([1, 3, 4]);
  });

  it("uses Map keys and shallow SameValueZero membership", () => {
    const key = { x: 1 };
    const distinct = { x: 1 };
    const right = new SandboxMap();
    right.map.set(key, "ignored");
    right.map.set(NaN, "ignored");
    right.map.set(-0, "ignored");
    const left = set(distinct, key, NaN, 0);
    const result = values(invoke(left, "intersection", right));
    expect(result).toEqual([key, NaN, 0]);
    expect(result[0]).toBe(key);
    expect(values(invoke(left, "difference", right))[0]).toBe(distinct);
    expect(values(invoke(set(key), "union", right))).toEqual([key, NaN, 0]);
    expect(values(invoke(left, "symmetricDifference", right))).toEqual([distinct]);
    expect(invoke(set(key, NaN), "isSubsetOf", right)).toBe(true);
    expect(invoke(left, "isSupersetOf", right)).toBe(true);
    expect(invoke(set(distinct), "isDisjointFrom", right)).toBe(true);
  });

  it("handles relational results, empty operands, and aliases", () => {
    expect(invoke(set(1), "isSubsetOf", set(1, 2))).toBe(true);
    expect(invoke(set(1, 2), "isSubsetOf", set(1))).toBe(false);
    expect(invoke(set(2), "isSubsetOf", set(1))).toBe(false);
    expect(invoke(set(1), "isSupersetOf", set(2))).toBe(false);
    expect(invoke(set(), "isSupersetOf", set(1))).toBe(false);
    expect(invoke(set(1), "isDisjointFrom", set(2, 3))).toBe(true);
    expect(invoke(set(1, 2), "isDisjointFrom", set(2))).toBe(false);
    for (const name of operations) {
      const left = set(1, 2);
      const result = invoke(left, name, left);
      if (result instanceof SandboxSet) {
        expect(result).not.toBe(left);
        expect(values(result)).toEqual(
          name === "difference" || name === "symmetricDifference" ? [] : [1, 2],
        );
      } else expect(result).toBe(name !== "isDisjointFrom");
      const empty = invoke(set(), name, set());
      if (empty instanceof SandboxSet) expect(values(empty)).toEqual([]);
      else expect(empty).toBe(true);
    }
  });

  it("rejects non-owned set-like operands even for an empty receiver", () => {
    for (const name of operations) {
      for (const bad of [undefined, null, 1, "abc", [], { size: 0, has: true, keys: [] }]) {
        expect(() => invoke(set(), name, bad)).toThrow(/requires a Set or Map/);
      }
    }
  });

  it("allows exact-fit overlapping output and rejects growth beyond the cap", () => {
    const left = new SandboxSet();
    for (let i = 0; i < MAX_GUEST_COLLECTION_ENTRIES; i++) left.set.add(i);
    expect(values(invoke(left, "union", left))).toHaveLength(MAX_GUEST_COLLECTION_ENTRIES);
    expect(values(invoke(left, "symmetricDifference", left))).toEqual([]);
    expect(() => invoke(left, "union", set(-1))).toThrow(/maximum/);
    expect(() => invoke(left, "symmetricDifference", set(-1))).toThrow(/maximum/);
    expect(left.set.size).toBe(MAX_GUEST_COLLECTION_ENTRIES);
  });

  it("checks deadlines during every operation, not just at entry", () => {
    for (const name of operations) {
      let clock = 0;
      setDeadlineClockForTesting(() => clock++);
      try {
        const deadline = new ExecutionDeadline(2);
        const left = set(1, 2, 3, 4);
        const right = name === "isDisjointFrom" ? set(5, 6, 7, 8) : left;
        expect(() => invokeSetOperation(left, name, right, deadline)).toThrow(/timed out/);
      } finally {
        setDeadlineClockForTesting(undefined);
      }
    }
  });
});
