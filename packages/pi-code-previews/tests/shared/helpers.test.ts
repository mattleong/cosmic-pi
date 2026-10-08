import assert from "node:assert/strict";
import { test } from "vitest";
import { getObjectValue } from "../../src/shared/helpers";

test("getObjectValue reads only own properties from plain object values", () => {
  const ownUndefined = { value: undefined };
  const inherited = Object.create({ value: "inherited" });

  assert.equal(getObjectValue({ value: "own" }, "value"), "own");
  assert.equal(getObjectValue(ownUndefined, "value"), undefined);
  assert.equal(getObjectValue(inherited, "value"), undefined);
});

test("getObjectValue rejects arrays, null, primitives, and functions", () => {
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

  for (const value of values) assert.equal(getObjectValue(value, "value"), undefined);
});
