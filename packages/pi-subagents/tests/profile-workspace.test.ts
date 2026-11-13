import { describe, expect, it, vi } from "@effect/vitest";
import { deferredPromise } from "pi-cosmic-core/testing";
import { effectTest, step } from "./support/effect-test.ts";
import { profileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import {
  chooseFromPage,
  settleTurn,
  workspaceHarness,
  workspaceInspection as makeInspection,
} from "./fixtures/profile-workspace.ts";
import { declaredCandidate } from "./fixtures/profiles.ts";
import { ProfileEditVisit } from "../src/settings/profile-edit-visit.ts";
import type { JsonObject } from "pi-cosmic-core";
import type {
  ProfileWorkspaceComponent,
  ProfileWorkspaceOptions,
  ProfileWorkspaceSaveResult,
} from "../src/settings/profile-workspace.ts";

const openUndo = (component: ProfileWorkspaceComponent): void => {
  component.handleInput("u");
};

describe("editing visit integration", () => {
  effectTest(
    "passes the exact saved declaration restore through the existing save boundary",
    function* () {
      const raw = declaredCandidate("test/opening");
      const openingDocument: JsonObject = {
        version: 6,
        profileSets: { work: { profiles: { generalist: [raw] } } },
      };
      const initial = profileSettingsInspection({
        globalDocument: openingDocument,
        projectTrusted: true,
      });
      const disabledDocument: JsonObject = {
        version: 6,
        profileSets: { work: { profiles: { generalist: "disabled" } } },
      };
      const disabled = profileSettingsInspection({
        globalDocument: disabledDocument,
        projectTrusted: true,
      });
      const target = {
        kind: "profile-set" as const,
        set: { scope: "global" as const, name: "work" },
      };
      const editVisit = new ProfileEditVisit(initial);
      const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>(
        (_target, _profile, _draft, restore) =>
          Promise.resolve(
            restore
              ? { inspection: initial, receipt: { kind: "saved", document: openingDocument } }
              : { inspection: disabled, receipt: { kind: "saved", document: disabledDocument } },
          ),
      );
      const { component } = workspaceHarness({ target, inspection: initial, editVisit, saveDraft });
      chooseFromPage(component, "a", "remove");
      component.handleInput("\r");
      yield* step(settleTurn);
      openUndo(component);
      component.handleInput("\r");
      yield* step(settleTurn);
      expect(saveDraft.mock.calls[1]?.[3]).toEqual({ declaration: [raw] });
      expect(editVisit.isEdited(target, "generalist", initial)).toBe(false);
    },
  );
});

describe("profile workspace disposal", () => {
  effectTest(
    "lets submitted persistence settle but ignores every late UI continuation",
    function* () {
      const saveCell = deferredPromise<ProfileWorkspaceSaveResult>();
      let persistenceSettled = false;
      const save = saveCell.promise.then((result) => {
        persistenceSettled = true;
        return result;
      });
      const requestRender = vi.fn();
      const close = vi.fn();
      const saveDraft = vi.fn(() => save);
      const { component } = workspaceHarness({ requestRender, close, saveDraft });

      chooseFromPage(component, "a", "remove");
      component.handleInput("\r");
      yield* step(settleTurn);
      expect(saveDraft).toHaveBeenCalledTimes(1);
      component.dispose();
      component.dispose();
      const rendersAtDispose = requestRender.mock.calls.length;
      component.handleInput("p");
      component.invalidate();
      expect(component.render(100)).toEqual([]);

      saveCell.resolve({ inspection: makeInspection() });
      yield* step(settleTurn);
      expect(persistenceSettled).toBe(true);
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(close).not.toHaveBeenCalled();
    },
  );

  it("loads no models once disposed", () => {
    const requestRender = vi.fn();
    const { component, loadModelPicker } = workspaceHarness({
      requestRender,
      initialFocus: "fields",
      initialField: "model",
    });
    component.dispose();
    const rendersAtDispose = requestRender.mock.calls.length;
    component.handleInput("\r");
    expect(loadModelPicker).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
    expect(component.render(100)).toEqual([]);
  });
});
