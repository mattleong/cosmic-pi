// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { afterEach, test } from "vitest";
import {
  booleanEnv,
  loadCodePreviewEnvironment,
  parseBoolean,
  parsePositiveInteger,
  performanceConfigFromEnvironment,
} from "../../src/config/env";

const originalValue = process.env.CODE_PREVIEW_TEST_BOOLEAN;

afterEach(() => {
  if (originalValue === undefined) delete process.env.CODE_PREVIEW_TEST_BOOLEAN;
  else process.env.CODE_PREVIEW_TEST_BOOLEAN = originalValue;
});

it.effect("decodes performance thresholds once through Effect Config", () =>
  Effect.gen(function* () {
    const environment = yield* loadCodePreviewEnvironment;
    const performance = performanceConfigFromEnvironment(environment);
    assert.equal(performance.asyncRenderChars, 1234);
    assert.equal(performance.cacheLimit, 192);
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({
        env: {
          CODE_PREVIEW_ASYNC_RENDER_CHARS: "1234",
          CODE_PREVIEW_CACHE_LIMIT: "invalid",
        },
      }),
    ),
  ),
);

test("boolean environment values recognize explicit true and false forms", () => {
  for (const value of ["1", "true", "ON", " yes "]) assert.equal(parseBoolean(value), true);
  for (const value of ["0", "false", "OFF", " no "]) assert.equal(parseBoolean(value), false);
});

test("invalid boolean environment values preserve the configured fallback", () => {
  process.env.CODE_PREVIEW_TEST_BOOLEAN = "invalid";
  assert.equal(booleanEnv("CODE_PREVIEW_TEST_BOOLEAN", true), true);
  assert.equal(booleanEnv("CODE_PREVIEW_TEST_BOOLEAN", false), false);
});

test("positive integer environment values reject fractions and unsafe integers", () => {
  assert.equal(parsePositiveInteger("2"), 2);
  assert.equal(parsePositiveInteger("0.5"), undefined);
  assert.equal(parsePositiveInteger("1.5"), undefined);
  assert.equal(parsePositiveInteger("0"), undefined);
  assert.equal(parsePositiveInteger(String(Number.MAX_SAFE_INTEGER + 1)), undefined);
});
