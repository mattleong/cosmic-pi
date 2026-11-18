import { describe, expect } from "vitest";
import type { OpenAIFastMode } from "pi-better-openai/fast-models";
import { modelSelector } from "pi-cosmic-ui/manager/model-picker";
import { modelFixture } from "pi-cosmic-core/testing";
import {
  availableCandidateModel,
  loadCandidateModelPicker,
  ProfileModelCatalog,
} from "../src/settings/profile-model-catalog.ts";
import { chooseFromPage, settleTurn, workspaceHarness } from "./fixtures/profile-workspace.ts";
import { profileCandidate } from "./fixtures/profiles.ts";
import { effectTest, step } from "./support/effect-test.ts";

const solModel = modelFixture({ provider: "openai-codex", id: "gpt-6.2-sol" });
const priorityModel = modelFixture({ provider: "openai", id: "priority-only" });
const sol = modelSelector(solModel);
const priority = modelSelector(priorityModel);
const editor = (
  model: string,
  parentModel: string,
  openaiFastMode: OpenAIFastMode = false,
  available = [solModel, priorityModel],
) => {
  const snapshot = new ProfileModelCatalog({
    getAvailable: () => available,
    getError: () => undefined,
    refresh: () => Promise.resolve({ aborted: false }),
  }).capture();
  return workspaceHarness(
    {
      parentModel,
      initialFocus: "fields",
      initialField: "openaiFastMode",
      availableModel: (selector) => availableCandidateModel(selector, snapshot, parentModel),
      loadModelPicker: (candidate) =>
        loadCandidateModelPicker({ candidate, piCatalog: snapshot, parentSelector: parentModel }),
    },
    [profileCandidate(model, { openaiFastMode })],
  );
};

describe("profile fast mode choices", () => {
  effectTest("saves the three distinct modes for a candidate inheriting Sol 6.2", function* () {
    const h = editor("parent", sol);
    chooseFromPage(h.component, "\r", "ultrafast");
    yield* step(settleTurn);
    expect(h.candidates()[0]).toMatchObject({ model: "parent", openaiFastMode: "ultrafast" });
    for (const mode of [true, false]) {
      for (const key of ["\r", "k", "\r"]) h.component.handleInput(key);
      yield* step(settleTurn);
      expect(h.candidates()[0]).toMatchObject({ model: "parent", openaiFastMode: mode });
    }
  });

  effectTest("clears ultrafast with a notice when switching to a fast-only parent", function* () {
    const h = editor(sol, priority, "ultrafast");
    for (const key of ["m", ...Array.from("inherit"), "\r"]) h.component.handleInput(key);
    yield* step(settleTurn);
    expect(h.candidates()[0]).toMatchObject({ model: "parent", openaiFastMode: false });
    expect(h.component.status?.text).toMatch(/ultrafast/i);
  });

  effectTest(
    "an unavailable model can keep or clear a saved tier, but can't enable it",
    function* () {
      const h = editor(sol, sol, "ultrafast", []);
      h.component.handleInput("\r");
      h.component.handleInput("\u001b");
      expect(h.saveDraft).not.toHaveBeenCalled();
      expect(h.candidates()[0]?.openaiFastMode).toBe("ultrafast");
      chooseFromPage(h.component, "\r", "off");
      yield* step(settleTurn);
      expect(h.candidates()[0]?.openaiFastMode).toBe(false);
      h.component.handleInput("\r");
      expect(h.component.hasOverlay).toBe(false);
    },
  );
});
