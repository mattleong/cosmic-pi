import { describe, expect, it, vi } from "@effect/vitest";
import { deferredPromise, plainTheme } from "pi-cosmic-core/testing";
import { effectTest, step } from "./support/effect-test.ts";
import { profileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import {
  chooseFromPage,
  settleTurn,
  workspaceHarness,
  workspaceInspection as makeInspection,
} from "./fixtures/profile-workspace.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";
import { ProfileEditVisit } from "../src/settings/profile-edit-visit.ts";
import type { JsonObject } from "pi-cosmic-core";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
  type ProfileWorkspaceSaveResult,
} from "../src/settings/profile-workspace.ts";
import * as Arr from "effect/Array";

const baseOptions = (
  overrides: Partial<ProfileWorkspaceOptions> = {},
): ProfileWorkspaceOptions => ({
  theme: plainTheme,
  inspection: makeInspection(),
  target: { kind: "session" },
  initialProfile: "generalist",
  parentEffort: "high",
  getHeight: () => 30,
  requestRender: () => {},
  close: () => {},
  saveDraft: () => Promise.resolve({ inspection: makeInspection() }),
  loadModelPicker: (_profile, candidateIndex, candidate) =>
    Promise.resolve({
      choices: [],
      current: candidate.model,
      context: {
        profile: "generalist",
        candidateIndex,
        runtime: candidate.runtime,
      },
    }),
  supportedPiEfforts: () => undefined,
  ...overrides,
});

const chooseDelete = (component: ProfileWorkspaceComponent): void =>
  chooseFromPage(component, "a", "remove");

const openUndo = (component: ProfileWorkspaceComponent): void => {
  component.handleInput("l");
  component.handleInput("G");
  component.handleInput("\r");
};

const liveCatalogEditor = () => {
  const loadModelPicker = vi.fn<ProfileWorkspaceOptions["loadModelPicker"]>(
    (profile, candidateIndex, candidate) =>
      Promise.resolve({
        choices: Arr.map(["live-older", "live-default"], (selector) => ({
          provider: candidate.runtime,
          id: selector,
          selector,
          fastModeAvailable: false,
        })),
        current: candidate.model,
        defaultSelector: "live-default",
        context: { profile, candidateIndex, runtime: candidate.runtime },
      }),
  );
  const editor = workspaceHarness({ loadModelPicker }, [profileCandidate("test/first")]);
  const chooseRunWith = (value: string) => chooseFromPage(editor.component, "r", value);
  return { ...editor, loadModelPicker, chooseRunWith };
};

describe("runtime switches", () => {
  effectTest("keeps native runtime and model unchanged after failed discovery", function* () {
    const editor = liveCatalogEditor();
    editor.loadModelPicker.mockRejectedValueOnce(new Error("Discovery failed"));
    editor.chooseRunWith("local/codex");
    yield* step(settleTurn);
    expect(editor.saveDraft).not.toHaveBeenCalled();
    expect(editor.candidates()).toEqual([profileCandidate("test/first")]);
  });
});

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
      const component = new ProfileWorkspaceComponent(
        baseOptions({ target, inspection: initial, editVisit, saveDraft }),
      );
      chooseDelete(component);
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
      const component = new ProfileWorkspaceComponent(
        baseOptions({ requestRender, close, saveDraft }),
      );

      chooseDelete(component);
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
      {
        expect(persistenceSettled).toBe(true);
        expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
        expect(close).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["model"] as const)("aborts %s loading and ignores its late result", (field) => {
    type PickerData = Awaited<ReturnType<ProfileWorkspaceOptions["loadModelPicker"]>>;
    const pickerCell = deferredPromise<PickerData>();
    let capturedSignal: AbortSignal | undefined;
    const requestRender = vi.fn();
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        requestRender,
        close,
        initialFocus: "fields",
        initialField: field,
        initialAdvancedExpanded: true,
        inspection: makeInspection({
          revision: 1,
          overrides: {
            generalist: {
              candidates: [profileCandidate("gpt-5.4", { runtime: "codex", openaiFastMode: true })],
            },
          },
        }),
        loadModelPicker: (_profile, _index, _candidate, signal) => {
          capturedSignal = signal;
          return pickerCell.promise;
        },
      }),
    );

    component.handleInput("\r");
    expect(capturedSignal).toBeDefined();
    component.dispose();
    expect(capturedSignal?.aborted).toBe(true);
    const rendersAtDispose = requestRender.mock.calls.length;
    pickerCell.resolve({
      choices: [],
      current: "parent",
      context: { profile: "generalist", candidateIndex: 0, runtime: "pi" },
    });
    return settleTurn().then(() => {
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(close).not.toHaveBeenCalled();
      expect(component.render(100)).toEqual([]);
      return undefined;
    });
  });
});
