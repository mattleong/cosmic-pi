import { describe, expect, it, vi } from "@effect/vitest";
import { deferredPromise, plainTheme } from "pi-cosmic-core/testing";
import { effectTest, step } from "./support/effect-test.ts";
import {
  inheritedInvalidInspection,
  makeProfileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { settleTurn, workspaceHarness } from "./fixtures/profile-workspace.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";
import type { SessionProfileOverrideSeed } from "../src/profiles/session-overrides.ts";
import { inheritSessionDraft } from "../src/settings/profile-route-editor.ts";
import { ProfileEditVisit } from "../src/settings/profile-edit-visit.ts";
import type { JsonObject } from "pi-cosmic-core";
import type { CandidateMenuAction } from "../src/settings/ui/profile-workspace-actions.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
  type ProfileWorkspaceSaveResult,
} from "../src/settings/profile-workspace.ts";

const makeInspection = (seed?: SessionProfileOverrideSeed) =>
  makeProfileSettingsInspection(
    {
      globalDocument: {
        version: 6,
        defaultProfileSet: "default",
        profileSets: { default: { profiles: {} } },
      },
      projectTrusted: true,
    },
    seed,
  );

const invalidBaselineInspection = () => {
  const initial = makeInspection();
  return makeInspection({
    revision: 2,
    overrides: {},
    baseline: {
      origin: { scope: "global", name: "broken", invalid: true },
      profiles: {
        ...initial.session.baseline.profiles,
        generalist: { candidates: [] },
      },
      profileSources: {
        ...initial.session.baseline.profileSources,
        generalist: "global-invalid",
      },
    },
  });
};

const baseOptions = (
  overrides: Partial<ProfileWorkspaceOptions> = {},
): ProfileWorkspaceOptions => ({
  theme: plainTheme,
  inspection: makeInspection(),
  target: { kind: "session" },
  initialProfile: "generalist",
  parentEffort: "high",
  preferredPiModel: () => "openai-codex/gpt-5.6-sol",
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
        host: candidate.host,
        runtime: candidate.runtime,
      },
    }),
  supportedPiEfforts: () => undefined,
  fastModeAvailable: () => false,
  ...overrides,
});

const openFields = (component: ProfileWorkspaceComponent): void => {
  component.handleInput("\u001b[C");
};

const chooseAction = (component: ProfileWorkspaceComponent, action: CandidateMenuAction): void => {
  component.handleInput("a");
  component.handleInput("/");
  for (const key of action) component.handleInput(key);
  component.handleInput("\r");
};
const chooseDelete = (component: ProfileWorkspaceComponent): void =>
  chooseAction(component, "remove");

const openUndo = (component: ProfileWorkspaceComponent): void => {
  component.handleInput("l");
  component.handleInput("G");
  component.handleInput("\r");
};

const modelEditor = (count = 3) => {
  const original = Array.from({ length: count }, (_, index) =>
    profileCandidate(`openai/model-${index}`),
  );
  const editor = workspaceHarness({}, original);
  openFields(editor.component);
  const act = (action: CandidateMenuAction): void => chooseAction(editor.component, action);
  return { ...editor, original, act };
};

describe("candidate menu actions", () => {
  effectTest("keeps the moved model selected across repeated moves and saves", function* () {
    const editor = modelEditor();
    const [first, second, third] = editor.original;
    editor.act("move-down");
    yield* step(settleTurn);
    expect(editor.candidates()).toEqual([second, first, third]);

    editor.act("move-down");
    yield* step(settleTurn);
    expect(editor.candidates()).toEqual([second, third, first]);

    editor.act("move-up");
    yield* step(settleTurn);
    expect(editor.candidates()).toEqual([second, first, third]);
    editor.act("move-up");
    yield* step(settleTurn);
    expect(editor.candidates()).toEqual(editor.original);

    editor.act("remove");
    editor.component.handleInput("\r");
    yield* step(settleTurn);
    expect(editor.candidates()).toEqual([second, third]);
  });

  effectTest("does not save moves beyond the first or last position", function* () {
    const editor = modelEditor(2);
    editor.act("move-up");
    expect(editor.saveDraft).not.toHaveBeenCalled();
    editor.component.handleInput("\u001b");
    editor.component.handleInput("\u001b");
    editor.act("move-down");
    yield* step(settleTurn);
    editor.saveDraft.mockClear();
    editor.act("move-down");
    expect(editor.saveDraft).not.toHaveBeenCalled();
    expect(editor.candidates()).toEqual([...editor.original].reverse());
  });

  effectTest(
    "requires confirmation, allows cancellation, and selects a remaining model after deletion",
    function* () {
      const editor = modelEditor();
      editor.act("move-down");
      yield* step(settleTurn);
      editor.saveDraft.mockClear();
      editor.act("remove");
      expect(editor.saveDraft).not.toHaveBeenCalled();
      editor.component.handleInput("\u001b");
      expect(editor.saveDraft).not.toHaveBeenCalled();

      editor.act("remove");
      editor.component.handleInput("x");
      expect(editor.saveDraft).not.toHaveBeenCalled();
      editor.component.handleInput("\r");
      yield* step(settleTurn);
      expect(editor.candidates()).toEqual([editor.original[1], editor.original[2]]);
      editor.act("remove");
      editor.component.handleInput("\r");
      yield* step(settleTurn);
      expect(editor.candidates()).toEqual([editor.original[2]]);
    },
  );

  effectTest(
    "omits single-model moves and disables the profile only after confirmed deletion",
    function* () {
      const editor = modelEditor(1);
      editor.act("remove");
      expect(editor.saveDraft).not.toHaveBeenCalled();
      editor.component.handleInput("\r");
      yield* step(settleTurn);
      expect(editor.saveDraft).toHaveBeenCalledWith({ kind: "session" }, "generalist", {
        kind: "disabled",
        candidates: [],
      });
    },
  );
});

describe("profile workspace navigation", () => {
  effectTest(
    "honors configured confirmation and cancellation without bypassing the warning",
    function* () {
      const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
      const component = new ProfileWorkspaceComponent(
        baseOptions({
          saveDraft,
          matchesKeybinding: (data, id) =>
            (id === "tui.select.confirm" && data === "\u0018") ||
            (id === "tui.select.cancel" && data === "\u0014"),
        }),
      );
      chooseDelete(component);
      component.handleInput("\u0014");
      expect(saveDraft).not.toHaveBeenCalled();
      chooseDelete(component);
      expect(saveDraft).not.toHaveBeenCalled();
      component.handleInput("\u0018");
      yield* step(settleTurn);
      expect(saveDraft).toHaveBeenCalledWith({ kind: "session" }, "generalist", {
        kind: "disabled",
        candidates: [],
      });
    },
  );

  it("does not bind route mutations to raw keys", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    component.handleInput("d");
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("keeps an invalid clean Current Session baseline fail-closed", () => {
    const inspection = invalidBaselineInspection();
    expect(inheritSessionDraft(inspection, "generalist")).toEqual({
      kind: "invalid",
      candidates: [],
    });
  });

  it.each([false, true])(
    "keeps invalid Project routes recoverable by adding a model, own declaration %s",
    (own) => {
      const loadModelPicker = vi.fn(baseOptions().loadModelPicker);
      const saveDraft = vi.fn(baseOptions().saveDraft);
      const component = new ProfileWorkspaceComponent(
        baseOptions({
          inspection: inheritedInvalidInspection(own, "generalist"),
          target: { kind: "profile-set", set: { scope: "project", name: "partial" } },
          loadModelPicker,
          saveDraft,
        }),
      );
      component.handleInput("m");
      expect(loadModelPicker).toHaveBeenCalled();
      component.handleInput("\u001b");
      expect(saveDraft).not.toHaveBeenCalled();
    },
  );

  it("edits Current Session profiles after using a saved set", () => {
    const initial = makeInspection();
    const original = initial.session.baseline.profiles.generalist.candidates[0]!;
    const profiles = {
      ...initial.session.baseline.profiles,
      generalist: { candidates: [{ ...original, model: "openai/detached" }] },
    };
    const detached = makeInspection({
      revision: 1,
      overrides: {},
      baseline: {
        origin: { scope: "global", name: "saved" },
        profiles,
        profileSources: initial.session.baseline.profileSources,
      },
    });
    const component = new ProfileWorkspaceComponent(baseOptions({ inspection: detached }));

    component.handleInput("\r");

    expect(component.render(120).join("\n")).toContain("openai/detached");
  });

  it("expands Advanced without persisting a route", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));
    openFields(component);
    for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");

    component.handleInput("\r");

    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe("editing visit integration", () => {
  effectTest(
    "attributes the committed save before notifying the dashboard and restores preexisting session edits",
    function* () {
      const candidate = {
        ...makeInspection().session.baseline.profiles.generalist.candidates[0]!,
        model: "test/preexisting",
      };
      const initial = makeInspection({
        revision: 3,
        overrides: { generalist: { candidates: [candidate] } },
      });
      let current = initial;
      const editVisit = new ProfileEditVisit(initial);
      const onInspection = vi.fn((inspection: ProfileWorkspaceOptions["inspection"]) => {
        expect(editVisit.isEdited({ kind: "session" }, "generalist", inspection)).toBe(
          inspection.session.overrides.generalist?.candidates.length === 0,
        );
      });
      const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>((_target, _profile, draft) => {
        current = makeInspection({
          revision: current.session.revision + 1,
          baseline: initial.session.baseline,
          overrides: { generalist: { candidates: draft.candidates } },
        });
        return Promise.resolve({
          inspection: current,
          receipt: { kind: "session", snapshot: current.session },
        });
      });
      const component = new ProfileWorkspaceComponent(
        baseOptions({ inspection: initial, editVisit, onInspection, saveDraft }),
      );
      chooseDelete(component);
      component.handleInput("\r");
      yield* step(settleTurn);
      expect(current.session.overrides.generalist?.candidates).toEqual([]);
      expect(onInspection).toHaveBeenCalledOnce();
      openUndo(component);
      expect(saveDraft).toHaveBeenCalledOnce();
      component.handleInput("\r");
      yield* step(settleTurn);
      expect(current.session.overrides.generalist?.candidates).toEqual([candidate]);
      expect(editVisit.isEdited({ kind: "session" }, "generalist", current)).toBe(false);
      openUndo(component);
      expect(component.hasOverlay).toBe(false);
      expect(saveDraft).toHaveBeenCalledTimes(2);
    },
  );

  effectTest(
    "passes the exact saved declaration restore through the existing save boundary",
    function* () {
      const raw = declaredCandidate("test/opening");
      const openingDocument: JsonObject = {
        version: 6,
        profileSets: { work: { profiles: { generalist: [raw] } } },
      };
      const initial = makeProfileSettingsInspection({
        globalDocument: openingDocument,
        projectTrusted: true,
      });
      const disabledDocument: JsonObject = {
        version: 6,
        profileSets: { work: { profiles: { generalist: "disabled" } } },
      };
      const disabled = makeProfileSettingsInspection({
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
      expect(saveDraft.mock.calls[1]?.[3]).toEqual({ sourceVersion: 6, declaration: [raw] });
      expect(editVisit.isEdited(target, "generalist", initial)).toBe(false);
    },
  );

  effectTest("does not offer undo when a refresh lacks a committed receipt", function* () {
    const initial = makeInspection();
    const changed = makeInspection({ revision: 1, overrides: { generalist: { candidates: [] } } });
    const editVisit = new ProfileEditVisit(initial);
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: changed }));
    const component = new ProfileWorkspaceComponent(
      baseOptions({ inspection: initial, editVisit, saveDraft }),
    );
    chooseDelete(component);
    component.handleInput("\r");
    yield* step(settleTurn);
    expect(editVisit.isEdited({ kind: "session" }, "generalist", changed)).toBe(false);
    openUndo(component);
    expect(component.isBusy).toBe(false);
    expect(saveDraft).toHaveBeenCalledOnce();
  });
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
      const onDispose = vi.fn();
      const saveDraft = vi.fn(() => save);
      const component = new ProfileWorkspaceComponent(
        baseOptions({ requestRender, close, onDispose, saveDraft }),
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
        expect(onDispose).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["model", "effort", "openaiFastMode"] as const)(
    "aborts %s loading and ignores its late result",
    (field) => {
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
                candidates: [
                  profileCandidate("gpt-5.4", { runtime: "codex", openaiFastMode: true }),
                ],
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
        context: { profile: "generalist", candidateIndex: 0, host: "local", runtime: "pi" },
      });
      return settleTurn().then(() => {
        expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
        expect(close).not.toHaveBeenCalled();
        expect(component.render(100)).toEqual([]);
      });
    },
  );

  effectTest(
    "arrows never commit field or action pickers, including custom confirm bindings",
    function* () {
      for (const [custom, shortcut] of [
        [false, "e"],
        [true, "e"],
        [false, "a"],
        [true, "a"],
      ] as const) {
        const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>(baseOptions().saveDraft);
        const component = new ProfileWorkspaceComponent(
          baseOptions({
            saveDraft,
            matchesKeybinding: custom
              ? (data, id) => id === "tui.select.confirm" && data.startsWith("\u001b[")
              : undefined,
          }),
        );
        component.handleInput(shortcut);
        if (shortcut === "e") component.handleInput("\u001b[A");
        component.handleInput("\u001b[C");
        expect(saveDraft).not.toHaveBeenCalled();
        component.handleInput("\r");
        yield* step(settleTurn);
        expect(saveDraft).toHaveBeenCalledOnce();
        component.dispose();
      }
    },
  );

  it("transfers inactive profile and candidate selection memory when replacing a target", () => {
    const options = baseOptions({ initialProfile: "worker", initialFocus: "fields" });
    const component = new ProfileWorkspaceComponent(options);
    component.handleInput("e");
    component.handleInput("\u001b");
    for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
    component.handleInput("\r"); // Expand Advanced for worker.
    component.handleInput("\u001b[B");
    component.handleInput("\u001b");
    component.handleInput("\u001b[B");
    component.handleInput("\r");
    component.handleInput("e");
    component.handleInput("\u001b");
    const position = component.getPosition();
    component.dispose();
    const replacement = new ProfileWorkspaceComponent({ ...options, ...position });
    expect(replacement.getPosition()).toEqual(position);
    replacement.handleInput("\u001b");
    replacement.handleInput("\u001b[A");
    replacement.handleInput("\r");
    expect(replacement.getPosition()).toMatchObject({
      initialProfile: "worker",
      initialField: "context",
      initialAdvancedExpanded: true,
    });
    replacement.dispose();
  });

  it("shows optimistic conflict feedback after refreshing Current Session", () => {
    const refreshed = makeInspection();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        saveDraft: () =>
          Promise.resolve({
            inspection: refreshed,
            conflictMessage: "Current Session changed while you were editing. Try again.",
          }),
      }),
    );

    chooseDelete(component);
    component.handleInput("\r");
    return settleTurn().then(() => {
      expect(component.render(100).join("\n")).toContain("changed while you were editing");
    });
  });
});
