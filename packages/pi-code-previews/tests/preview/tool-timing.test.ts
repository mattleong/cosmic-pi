import assert from "node:assert/strict";
import { test } from "vitest";
import { getCodePreviewAnimationFrame } from "../../src/preview/tool-timing";

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
