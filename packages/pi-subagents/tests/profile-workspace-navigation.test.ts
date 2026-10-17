import { deferredPromise } from "pi-cosmic-core/testing";
import { effectTest, step } from "./support/effect-test.ts";
import { describe, expect, vi } from "vitest";
import type { ProfileWorkspaceSaveResult } from "../src/settings/profile-workspace.ts";
import { settleTurn, workspaceHarness } from "./fixtures/profile-workspace.ts";
import { profileCandidate } from "./fixtures/profiles.ts";

const first = profileCandidate("test/first");

describe("fixed-target profile workspace", () => {
  effectTest("blocks overlapping edits and navigation during a submitted save", function* () {
    const cell = deferredPromise<ProfileWorkspaceSaveResult>();
    const saveDraft = vi.fn(() => cell.promise);
    const h = workspaceHarness({ saveDraft });
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    for (const key of ["p", "s", "t", "+", "a", "m"]) h.component.handleInput(key);
    yield* step(settleTurn);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    cell.resolve({ inspection: h.inspection() });
    yield* step(settleTurn);
  });

  effectTest("blocks edits after refresh failure but permits backing out", function* () {
    const saveDraft = vi.fn(() => Promise.resolve({ refreshError: "Reopen required" }));
    const h = workspaceHarness({ saveDraft }, [first]);
    h.component.handleInput("e");
    h.component.handleInput("k");
    h.component.handleInput("\r");
    yield* step(settleTurn);
    h.component.handleInput("+");
    expect(h.loadModelPicker).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    expect(h.close).toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });
});
