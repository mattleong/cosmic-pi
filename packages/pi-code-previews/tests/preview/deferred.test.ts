import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { macrotask, provideBuiltLayer } from "pi-cosmic-core/testing";
import { afterEach, test } from "vitest";
import {
  clearCodePreviewSessionCapability,
  captureCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { CodePreviewSchedulerService } from "../../src/application/scheduler";
import { plainTheme } from "../support/render";
import { inertCapability } from "../support/renderer-host";
import { cachedDeferredPreview, cachedPreview } from "../../src/tools/renderers/shared/cache";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

afterEach(() => clearCodePreviewSessionCapability());

/** A deferred-preview test under a session capability backed by the real scheduler. */
const scheduledTest = (name: string, body: () => Generator<Effect.Effect<void>, void, never>) =>
  it.effect(name, () =>
    CodePreviewSchedulerService.use((scheduler) =>
      Effect.sync(() => installCodePreviewSessionCapability(inertCapability(scheduler))),
    ).pipe(Effect.andThen(Effect.gen(body)), provideBuiltLayer(CodePreviewSchedulerService.layer)),
  );

// Deferred work runs on a later event-loop turn; the bound keeps a missed publication a failure.
const turnsUntil = Effect.fnUntraced(function* (done: () => boolean) {
  for (let turn = 0; turn < 20 && !done(); turn++) yield* macrotask;
});

const component = (text: string) => new Text(plainTheme.fg("toolOutput", text), 0, 0);

type PreviewArgs = Parameters<typeof cachedDeferredPreview>;
const preview = (
  state: PreviewArgs[0],
  source: string,
  ...rest: [PreviewArgs[6], PreviewArgs[7]]
) =>
  cachedDeferredPreview(
    state,
    "preview",
    [source],
    source.length,
    "loading",
    plainTheme,
    ...rest,
    captureCodePreviewSessionCapability(),
  );

test("large previews remain synchronous before session acquisition", () => {
  const state = {};
  let computes = 0;
  const rendered = preview(
    state,
    Fn.pipe("a", Str.repeat(20_000)),
    () => {
      computes++;
      return component("ready");
    },
    () => assert.fail("outside-session preview must not invalidate"),
  );
  assert.equal(computes, 1);
  assert.match(Arr.join(rendered.render(80), "\n"), /ready/);
});

scheduledTest(
  "cache replacement cancels obsolete deferred publication and compares exact source",
  function* () {
    const state = {};
    let firstComputes = 0;
    let secondComputes = 0;
    let invalidations = 0;
    preview(
      state,
      Fn.pipe("a", Str.repeat(20_000)),
      () => {
        firstComputes++;
        return component("obsolete");
      },
      () => invalidations++,
    );
    const current = preview(
      state,
      Fn.pipe("b", Str.repeat(20_000)),
      () => {
        secondComputes++;
        return component("current");
      },
      () => invalidations++,
    );
    yield* turnsUntil(() => invalidations > 0);
    assert.equal(firstComputes, 0);
    assert.equal(secondComputes, 1);
    assert.equal(invalidations, 1);
    assert.match(Arr.join(current.render(80), "\n"), /current/);
  },
);

scheduledTest("a failing replacement cannot reuse a cancelled deferred preview", function* () {
  const state = {};
  const source = Fn.pipe("a", Str.repeat(20_000));
  const obsolete = preview(
    state,
    source,
    () => assert.fail("cancelled work ran"),
    () => {},
  );
  assert.throws(() =>
    cachedPreview(state, "preview", [], () => {
      throw new Error("failed");
    }),
  );
  let published = false;
  const current = preview(
    state,
    source,
    () => component("ready"),
    () => {
      published = true;
    },
  );
  assert.notEqual(current, obsolete);
  yield* turnsUntil(() => published);
  assert.match(Arr.join(current.render(80), "\n"), /ready/);
});

scheduledTest("deferred publication isolates a throwing host invalidation callback", function* () {
  const state = {};
  let invalidated = false;
  const current = preview(
    state,
    Fn.pipe("x", Str.repeat(20_000)),
    () => component("ready"),
    () => {
      invalidated = true;
      throw new Error("host invalidation failed");
    },
  );
  yield* turnsUntil(() => invalidated);
  assert.equal(invalidated, true);
  assert.match(Arr.join(current.render(80), "\n"), /ready/);
});
