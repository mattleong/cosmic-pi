// Test-only runner verifies the installed session capability contract.
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
import { previewScheduleEffect } from "../../src/application/scheduler";
import { plainTheme } from "../support/render";
import { cachedDeferredPreview } from "../../src/tools/renderers/shared/cache";
import { eventLoopTurn } from "../support/effect-test";

afterEach(() => clearCodePreviewSessionCapability());

function installTestCapability(): void {
  // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
  const capability = {
    run: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
      Effect.runPromise(effect, signal ? { signal } : undefined),
    defer: (task: () => void) => {
      const fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task))));
      return () => fiber.interruptUnsafe();
    },
    schedule: (interval: number, task: () => void) => {
      const fiber = Effect.runFork(previewScheduleEffect(interval, task));
      return () => fiber.interruptUnsafe();
    },
  } as CodePreviewSessionCapability;
  installCodePreviewSessionCapability(capability);
}

const component = (text: string, theme: Theme = plainTheme) =>
  new Text(theme.fg("toolOutput", text), 0, 0);

type PreviewArgs = Parameters<typeof cachedDeferredPreview>;
const preview = (
  state: PreviewArgs[0],
  key: string,
  source: string,
  ...rest: [PreviewArgs[7], PreviewArgs[8]]
) => cachedDeferredPreview(state, "key", "component", key, source, "loading", plainTheme, ...rest);

test("large previews remain synchronous before session acquisition", () => {
  const state = {};
  let computes = 0;
  const rendered = preview(
    state,
    "hash",
    "a".repeat(20_000),
    () => {
      computes++;
      return component("ready");
    },
    () => assert.fail("outside-session preview must not invalidate"),
  );
  assert.equal(computes, 1);
  assert.match(rendered.render(80).join("\n"), /ready/);
});

test("cache replacement cancels obsolete deferred publication and compares exact source", () => {
  installTestCapability();
  const state = {};
  let firstComputes = 0;
  let secondComputes = 0;
  let invalidations = 0;
  preview(
    state,
    "colliding-hash-key",
    "a".repeat(20_000),
    () => {
      firstComputes++;
      return component("obsolete");
    },
    () => invalidations++,
  );
  const current = preview(
    state,
    "colliding-hash-key",
    "b".repeat(20_000),
    () => {
      secondComputes++;
      return component("current");
    },
    () => invalidations++,
  );
  return eventLoopTurn().then(() => {
    assert.equal(firstComputes, 0);
    assert.equal(secondComputes, 1);
    assert.equal(invalidations, 1);
    assert.match(current.render(80).join("\n"), /current/);
  });
});

test("deferred publication isolates a throwing host invalidation callback", () => {
  installTestCapability();
  const state = {};
  const current = preview(
    state,
    "deferred-key",
    "x".repeat(20_000),
    () => component("ready"),
    () => {
      throw new Error("host invalidation failed");
    },
  );
  return eventLoopTurn().then(() => {
    assert.match(current.render(80).join("\n"), /ready/);
  });
});
