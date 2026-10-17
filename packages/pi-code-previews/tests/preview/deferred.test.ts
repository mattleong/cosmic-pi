import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { afterEach, test } from "vitest";
import {
  clearCodePreviewSessionCapability,
  captureCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { plainTheme } from "../support/render";
import { cachedDeferredPreview, cachedPreview } from "../../src/tools/renderers/shared/cache";
import { effectTest, eventLoopTurn, step } from "../support/effect-test";

afterEach(() => clearCodePreviewSessionCapability());

function installTestCapability(): void {
  installCodePreviewSessionCapability({
    run: () => Promise.reject(new Error("not used")),
    defer: (task) => {
      const fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task))));
      return () => fiber.interruptUnsafe();
    },
    schedule: () => () => undefined,
  });
}

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

effectTest(
  "cache replacement cancels obsolete deferred publication and compares exact source",
  function* () {
    installTestCapability();
    const state = {};
    let firstComputes = 0;
    let secondComputes = 0;
    let invalidations = 0;
    preview(
      state,
      "a".repeat(20_000),
      () => {
        firstComputes++;
        return component("obsolete");
      },
      () => invalidations++,
    );
    const current = preview(
      state,
      "b".repeat(20_000),
      () => {
        secondComputes++;
        return component("current");
      },
      () => invalidations++,
    );
    yield* step(() => eventLoopTurn());
    assert.equal(firstComputes, 0);
    assert.equal(secondComputes, 1);
    assert.equal(invalidations, 1);
    assert.match(current.render(80).join("\n"), /current/);
  },
);

effectTest("a failing replacement cannot reuse a cancelled deferred preview", function* () {
  installTestCapability();
  const state = {};
  const source = "a".repeat(20_000);
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
  const current = preview(
    state,
    source,
    () => component("ready"),
    () => {},
  );
  assert.notEqual(current, obsolete);
  yield* step(() => eventLoopTurn());
  assert.match(current.render(80).join("\n"), /ready/);
});

effectTest("deferred publication isolates a throwing host invalidation callback", function* () {
  installTestCapability();
  const state = {};
  const current = preview(
    state,
    "x".repeat(20_000),
    () => component("ready"),
    () => {
      throw new Error("host invalidation failed");
    },
  );
  yield* step(() => eventLoopTurn());
  assert.match(current.render(80).join("\n"), /ready/);
});
