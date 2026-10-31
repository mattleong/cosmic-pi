import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vitest";
import { RexBtw, type BtwRequest } from "../src/btw.ts";
import { GitBranch } from "../src/git.ts";
import { RexBtwError, RexClient, type RexClientContract, type RexSplitInput } from "../src/rex.ts";

const CALLER = "block:caller";
const REQUEST: BtwRequest = {
  prompt: "why?",
  model: undefined,
  thinkingLevel: undefined,
  parent: undefined,
};

interface FakeRex {
  readonly splits: RexSplitInput[];
  readonly closed: Set<string>;
  splitFailure?: RexBtwError;
}

const fakeRex = (columns = 120) => {
  const state: FakeRex = { splits: [], closed: new Set() };
  let next = 0;
  const contract: RexClientContract = {
    paneColumns: (location) =>
      state.closed.has(location.blockId)
        ? Effect.fail(RexBtwError.make({ reason: "anchorMissing", message: "gone" }))
        : Effect.succeed(columns),
    split: (input) => {
      if (state.splitFailure) return Effect.fail(state.splitFailure);
      state.splits.push(input);
      next += 1;
      return Effect.succeed(`block:btw-${next}`);
    },
  };
  return { state, layer: Layer.succeed(RexClient, contract) };
};

const btwLayer = (rex: Layer.Layer<RexClient>) =>
  RexBtw.layer({
    cwd: "/projects/demo",
    extensionPath: "/extensions/pi-rex-btw/",
    shell: "/bin/zsh",
    location: { sessionId: "session:s", blockId: CALLER },
  }).pipe(
    Layer.provide(
      Layer.merge(
        rex,
        Layer.succeed(GitBranch, () => Effect.succeed("main")),
      ),
    ),
  );

describe("BTW pane placement", () => {
  it.effect("splits the caller first, then stacks beside the newest BTW pane", () => {
    const rex = fakeRex();
    return Effect.gen(function* () {
      const btw = yield* RexBtw;
      expect(yield* btw.open(REQUEST)).toBe("block:btw-1");
      expect(yield* btw.open(REQUEST)).toBe("block:btw-2");
      expect(Arr.map(rex.state.splits, (split) => split.anchorBlockId)).toEqual([
        CALLER,
        "block:btw-1",
      ]);
      expect(rex.state.splits[0]?.cwd).toBe("/projects/demo");
    }).pipe(Effect.provide(btwLayer(rex.layer)));
  });

  it.effect("falls back to the caller when the newest BTW pane was closed", () => {
    const rex = fakeRex();
    return Effect.gen(function* () {
      const btw = yield* RexBtw;
      yield* btw.open(REQUEST);
      rex.state.closed.add("block:btw-1");
      expect(yield* btw.open(REQUEST)).toBe("block:btw-2");
      expect(yield* btw.open(REQUEST)).toBe("block:btw-3");
      expect(Arr.map(rex.state.splits, (split) => split.anchorBlockId)).toEqual([
        CALLER,
        CALLER,
        "block:btw-2",
      ]);
    }).pipe(Effect.provide(btwLayer(rex.layer)));
  });

  it.effect("doesn't retry when a split may already have opened a pane", () => {
    const rex = fakeRex();
    return Effect.gen(function* () {
      const btw = yield* RexBtw;
      yield* btw.open(REQUEST);
      rex.state.splitFailure = RexBtwError.make({ reason: "uncertain", message: "maybe" });
      expect((yield* Effect.flip(btw.open(REQUEST))).reason).toBe("uncertain");
      expect(rex.state.splits).toHaveLength(1);
    }).pipe(Effect.provide(btwLayer(rex.layer)));
  });

  it.effect("splits narrow panes downward", () => {
    const rex = fakeRex(60);
    return Effect.gen(function* () {
      yield* (yield* RexBtw).open(REQUEST);
      expect(rex.state.splits[0]?.direction).toBe("below");
    }).pipe(Effect.provide(btwLayer(rex.layer)));
  });
});
