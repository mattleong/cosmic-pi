import assert from "node:assert/strict";
import { test } from "vitest";
import { getCodePreviewAnimationFrame } from "../../index";

test("animation frame is a read-only scalar projection of owned renderer state", () => {
  const state = Object.freeze({ codePreviewAnimationFrame: 7 });
  assert.equal(getCodePreviewAnimationFrame({ state }), 7);
  assert.deepEqual(state, { codePreviewAnimationFrame: 7 });
  assert.equal(getCodePreviewAnimationFrame({ state: { codePreviewAnimationFrame: 0 } }), 0);
});

test("missing, inherited and malformed animation frames use the first frame", () => {
  const values: unknown[] = [
    undefined,
    null,
    "7",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const frame of values)
    assert.equal(getCodePreviewAnimationFrame({ state: { codePreviewAnimationFrame: frame } }), 0);
  for (const state of [
    undefined,
    null,
    "state",
    [],
    Object.create({ codePreviewAnimationFrame: 9 }),
  ])
    assert.equal(getCodePreviewAnimationFrame({ state }), 0);
});

test("hostile state never invokes frame accessors or escapes the projection boundary", () => {
  let invoked = false;
  const state = Object.defineProperty({}, "codePreviewAnimationFrame", {
    get: () => {
      invoked = true;
      throw new Error("frame accessor is not data");
    },
  });
  assert.equal(getCodePreviewAnimationFrame({ state }), 0);
  assert.equal(invoked, false);
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile renderer state");
      },
    },
  );
  assert.equal(getCodePreviewAnimationFrame({ state: hostile }), 0);
  assert.equal(
    getCodePreviewAnimationFrame({
      get state() {
        throw new Error("retired context");
      },
    }),
    0,
  );
});
