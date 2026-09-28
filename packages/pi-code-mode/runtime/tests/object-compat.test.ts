import { describe, expect, it } from "@effect/vitest";
import { MAX_GUEST_COLLECTION_ENTRIES } from "../src/interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  makeInterpreterObject,
} from "../src/interpreter/model.js";
import { invokeObjectAssign, invokeObjectMethod } from "../src/stdlib/object.js";
import { SandboxMap } from "../src/values.js";

const node: AstNode = { type: "CallExpression" };
// An owned write seam for helper tests; runtime integration supplies circular-insertion guards.
const write = (
  target: InterpreterObject | InterpreterArray,
  key: string,
  value: InterpreterValue,
): void => {
  if (Array.isArray(target)) target[Number(key)] = value;
  else target[key] = value;
};
const assign = (...args: InterpreterArray) => invokeObjectAssign(args, node, write);

describe("Object shallow helpers", () => {
  it("preserves original member identity for objects and sparse arrays", () => {
    const member = { nested: [1] };
    const sparse: InterpreterArray = [];
    sparse[2] = member;
    for (const input of [{ member }, sparse]) {
      const values = invokeObjectMethod("values", [input], node);
      const entries = invokeObjectMethod("entries", [input], node);
      expect(values).toEqual([member]);
      expect(Array.isArray(values) && values[0]).toBe(member);
      expect(entries).toEqual([[Array.isArray(input) ? "2" : "member", member]]);
      expect(Array.isArray(entries) && Array.isArray(entries[0]) && entries[0][1]).toBe(member);
    }
    expect(invokeObjectMethod("hasOwn", [sparse, "length"], node)).toBe(true);
    expect(invokeObjectMethod("hasOwn", [sparse, "0"], node)).toBe(false);
    expect(invokeObjectMethod("hasOwn", [sparse, 2], node)).toBe(true);
  });

  it("keeps sandbox wrappers opaque and takes members by identity", () => {
    const wrapper = new SandboxMap();
    expect(invokeObjectMethod("values", [wrapper], node)).toEqual([]);
    expect(invokeObjectMethod("entries", [wrapper], node)).toEqual([]);
    expect(invokeObjectMethod("hasOwn", [wrapper, "map"], node)).toBe(false);
    const self = makeInterpreterObject();
    self.self = self;
    const values = invokeObjectMethod("values", [self], node);
    expect(Array.isArray(values) && values[0]).toBe(self);
    // Holes are not own entries, so a long sparse array has none.
    const sparse: InterpreterArray = [];
    sparse.length = MAX_GUEST_COLLECTION_ENTRIES + 1;
    expect(invokeObjectMethod("entries", [sparse], node)).toEqual([]);
  });
});

describe("Object.assign guarded helper", () => {
  it("mutates and returns the target while retaining shallow references", () => {
    const target: InterpreterObject = { old: 1, replaced: 0 };
    const member = { child: [] };
    expect(assign(target, null, undefined, { replaced: member }, { added: member })).toBe(target);
    expect(target).toEqual({ old: 1, replaced: member, added: member });
    expect(target.replaced).toBe(member);
    expect(target.added).toBe(member);
    expect(assign(target, target)).toBe(target);
    expect(assign(target)).toBe(target);
  });

  it("copies sparse array own indices and allows numeric-index array targets", () => {
    const member = { value: 1 };
    const source: InterpreterArray = [];
    source[2] = member;
    const object = assign({}, source);
    expect(object).toEqual({ "2": member });
    const target: InterpreterArray = [0];
    expect(assign(target, source, { "0": member })).toBe(target);
    expect(target.length).toBe(3);
    expect(target[0]).toBe(member);
    expect(target[2]).toBe(member);
    expect(Object.hasOwn(target, "1")).toBe(false);
    for (const key of ["length", "other", "01", "-1", "1.5"]) {
      expect(() => assign([], { [key]: 1 })).toThrow();
    }
    expect(() => assign([], { [MAX_GUEST_COLLECTION_ENTRIES]: 1 })).toThrow();
  });

  it("rejects invalid targets and sources without exposing wrappers", () => {
    expect(() => assign()).toThrow();
    for (const target of [null, undefined, 1, "x", true, new SandboxMap()]) {
      expect(() => assign(target, {})).toThrow();
    }
    expect(() => assign({}, "abc")).toThrow();
    expect(assign({}, new SandboxMap())).toEqual({});
  });

  it("blocks prototype keys on a target that has a prototype before invoking the write seam", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const source = makeInterpreterObject();
      source[key] = 1;
      const target = {};
      expect(() => assign(target, source)).toThrow();
      expect(target).toEqual({});
    }
  });

  it("lets the interpreter refuse a write before mutation", () => {
    const target: InterpreterObject = {};
    const member = {};
    expect(() =>
      invokeObjectAssign([target, { member }], node, (actualTarget, key, actualValue) => {
        expect(actualTarget).toBe(target);
        expect(key).toBe("member");
        expect(actualValue).toBe(member);
        throw new Error("insertion refused");
      }),
    ).toThrow("insertion refused");
    expect(target).toEqual({});
  });

  it("snapshots own keys but reads original values between writes", () => {
    const target: InterpreterObject = {};
    const source: InterpreterObject = { first: 1, second: 2 };
    invokeObjectAssign([target, source], node, (actualTarget, key, value) => {
      write(actualTarget, key, value);
      source.second = 3;
      source.later = 4;
    });
    expect(target).toEqual({ first: 1, second: 3 });
  });

  it("counts existing target entries and admits exact-cap replacements", () => {
    const target = makeInterpreterObject();
    for (let i = 0; i < MAX_GUEST_COLLECTION_ENTRIES - 1; i++) target[String(i)] = 0;
    expect(assign(target, { last: 1 })).toBe(target);
    expect(assign(target, { last: 2 })).toBe(target);
    expect(target.last).toBe(2);
    expect(() => assign(target, { extra: 1 })).toThrow();
    expect(Object.hasOwn(target, "extra")).toBe(false);
    target.extra = 1;
    expect(() => assign(target)).toThrow();
  });
});
