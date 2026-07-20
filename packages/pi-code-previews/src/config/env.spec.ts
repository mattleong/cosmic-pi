// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { booleanEnv, parseBoolean } from "./env";

const originalValue = process.env.CODE_PREVIEW_TEST_BOOLEAN;

afterEach(() => {
  if (originalValue === undefined) delete process.env.CODE_PREVIEW_TEST_BOOLEAN;
  else process.env.CODE_PREVIEW_TEST_BOOLEAN = originalValue;
});

test("boolean environment values recognize explicit true and false forms", () => {
  for (const value of ["1", "true", "ON", " yes "]) assert.equal(parseBoolean(value), true);
  for (const value of ["0", "false", "OFF", " no "]) assert.equal(parseBoolean(value), false);
});

test("invalid boolean environment values preserve the configured fallback", () => {
  process.env.CODE_PREVIEW_TEST_BOOLEAN = "invalid";
  assert.equal(booleanEnv("CODE_PREVIEW_TEST_BOOLEAN", true), true);
  assert.equal(booleanEnv("CODE_PREVIEW_TEST_BOOLEAN", false), false);
});
