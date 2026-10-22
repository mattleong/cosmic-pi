import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { BoundedProcessError } from "pi-cosmic-core";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { gitRunFailure } from "../src/boundary/git-worktree-process.ts";
import { probeFailureResult, runProbeEffect } from "../src/boundary/local-cli-harness.ts";
import { nodePath } from "./support/node-builtins.ts";

const spawnFailure = new BoundedProcessError({ operation: "spawn", message: "Unable to start." });
const streamFailure = new BoundedProcessError({ operation: "stream", message: "Unable to read." });

describe("process start failures", () => {
  it.effect("treats a probe that never started as cleaned up", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-subagents-missing-probe-");
      const result = yield* runProbeEffect(nodePath.join(directory, "missing"), [], {});
      expect(result).toMatchObject({ code: null, cleanupUnconfirmed: false });
    }).pipe(Effect.scoped),
  );

  it("leaves a probe group unconfirmed when its output fails after spawn", () => {
    expect(probeFailureResult(spawnFailure).cleanupUnconfirmed).toBe(false);
    // Candidate fallback stops on an unconfirmed probe, so a live group can't overlap the next one.
    expect(probeFailureResult(streamFailure).cleanupUnconfirmed).toBe(true);
  });

  it("keeps workspace artifacts only when Git may have started", () => {
    expect(gitRunFailure(spawnFailure).cleanupUnconfirmed).toBe(false);
    expect(gitRunFailure(streamFailure).cleanupUnconfirmed).toBe(true);
  });
});
