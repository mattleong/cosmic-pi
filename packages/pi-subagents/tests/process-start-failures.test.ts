import { describe, expect, it } from "@effect/vitest";
import { BoundedProcessError } from "pi-cosmic-core";
import { gitRunFailure } from "../src/boundary/git-worktree-process.ts";

const spawnFailure = BoundedProcessError.make({ operation: "spawn", message: "Unable to start." });
const streamFailure = BoundedProcessError.make({ operation: "stream", message: "Unable to read." });

describe("process start failures", () => {
  it("keeps workspace artifacts only when Git may have started", () => {
    expect(gitRunFailure(spawnFailure).cleanupUnconfirmed).toBe(false);
    expect(gitRunFailure(streamFailure).cleanupUnconfirmed).toBe(true);
  });
});
