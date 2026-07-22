// Test-only runner verifies the installed session capability contract.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/unsafeEffectTypeAssertion:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { afterEach, test } from "vitest";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../../src/application/capability";
import { testTheme } from "../../src/testing/render";
import { cachedDeferredPreview } from "../../src/tools/renderers/shared/cache";

afterEach(() => clearCodePreviewSessionCapability());

function installTestCapability(): void {
  const capability = {
    token: 1,
    run: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
      Effect.runPromise(effect, signal ? { signal } : undefined),
    fork: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
      Effect.runFork(effect, signal ? { signal } : undefined),
  } as unknown as CodePreviewSessionCapability;
  installCodePreviewSessionCapability(capability);
}

const component = (text: string, theme: Theme = testTheme()) =>
  new Text(theme.fg("toolOutput", text), 0, 0);

test("large previews remain synchronous before session acquisition", () => {
  const state = {};
  let computes = 0;
  const rendered = cachedDeferredPreview(
    state,
    "key",
    "component",
    "hash",
    "a".repeat(20_000),
    "loading",
    testTheme(),
    () => {
      computes++;
      return component("ready");
    },
    () => assert.fail("outside-session preview must not invalidate"),
  );
  assert.equal(computes, 1);
  assert.match(rendered.render(80).join("\n"), /ready/);
});

test("cache replacement cancels obsolete deferred publication and compares exact source", async () => {
  installTestCapability();
  const state = {};
  let firstComputes = 0;
  let secondComputes = 0;
  let invalidations = 0;
  cachedDeferredPreview(
    state,
    "key",
    "component",
    "colliding-hash-key",
    "a".repeat(20_000),
    "loading",
    testTheme(),
    () => {
      firstComputes++;
      return component("obsolete");
    },
    () => invalidations++,
  );
  const current = cachedDeferredPreview(
    state,
    "key",
    "component",
    "colliding-hash-key",
    "b".repeat(20_000),
    "loading",
    testTheme(),
    () => {
      secondComputes++;
      return component("current");
    },
    () => invalidations++,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstComputes, 0);
  assert.equal(secondComputes, 1);
  assert.equal(invalidations, 1);
  assert.match(current.render(80).join("\n"), /current/);
});

test("deferred publication isolates a throwing host invalidation callback", async () => {
  installTestCapability();
  const state = {};
  const current = cachedDeferredPreview(
    state,
    "key",
    "component",
    "deferred-key",
    "x".repeat(20_000),
    "loading",
    testTheme(),
    () => component("ready"),
    () => {
      throw new Error("host invalidation failed");
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(current.render(80).join("\n"), /ready/);
});
