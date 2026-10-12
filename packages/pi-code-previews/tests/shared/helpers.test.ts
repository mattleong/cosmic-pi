import assert from "node:assert/strict";
import { test } from "vitest";
import { hostObject, ownField } from "../../src/shared/untrusted-value";

test("ownField reads only own properties from decoded host objects", () => {
  const ownUndefined = { value: undefined };
  const inherited: unknown = Object.create({ value: "inherited" });

  assert.equal(ownField(hostObject({ value: "own" }), "value"), "own");
  assert.equal(ownField(hostObject(ownUndefined), "value"), undefined);
  assert.equal(ownField(hostObject(inherited), "value"), undefined);
});

test("hostObject rejects arrays, null, primitives, and functions", () => {
  const functionWithProperty = Object.assign(() => undefined, { value: "function" });
  const values = [
    ["array"],
    null,
    undefined,
    "text",
    1,
    true,
    1n,
    Symbol("value"),
    functionWithProperty,
  ];

  for (const value of values) {
    assert.equal(hostObject(value), undefined);
    assert.equal(ownField(hostObject(value), "value"), undefined);
  }
});
