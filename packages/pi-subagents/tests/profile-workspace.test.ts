import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { effectTest, step } from "./support/effect-test.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import type { SessionProfileOverrideSeed } from "../src/profiles/session-overrides.ts";
import { inheritSessionDraft } from "../src/settings/profile-route-editor.ts";
import { ProfileEditVisit } from "../src/settings/profile-edit-visit.ts";
import type { JsonObject } from "pi-cosmic-core";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  candidateFieldRows,
  type ProfileWorkspaceField,
} from "../src/settings/ui/profile-workspace-model.ts";
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

const inheritedInvalidProjectInspection = (withOwnInvalidRoute: boolean) => {
  const invalidRoute = {
    host: "local",
    runtime: "pi",
    model: "parent",
    effort: "impossible",
    context: "fresh",
    writeIntent: "read-only",
    openaiFastMode: false,
    closeOnReport: true,
  };
  return makeProfileSettingsInspection({
    globalDocument: {
      version: 6,
      defaultProfileSet: "lower",
      profileSets: { lower: { profiles: { generalist: invalidRoute } } },
    },
    projectDocument: {
      version: 6,
      defaultProfileSet: "partial",
      profileSets: {
        partial: { profiles: withOwnInvalidRoute ? { generalist: invalidRoute } : {} },
      },
    },
    projectTrusted: true,
  });
};

const invalidBaselineInspection = (withRepairOverride: boolean) => {
  const initial = makeInspection();
  const repair = initial.session.baseline.profiles.generalist;
  return makeInspection({
    revision: 2,
    overrides: withRepairOverride ? { generalist: repair } : {},
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

// SAFETY: The component tests use only the Theme methods implemented by this fixture.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const baseOptions = (
  overrides: Partial<ProfileWorkspaceOptions> = {},
): ProfileWorkspaceOptions => ({
  theme,
  inspection: makeInspection(),
  projectTrusted: true,
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

const settle = (): Promise<void> =>
  Effect.runPromise(Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow)));

const openFields = (component: ProfileWorkspaceComponent): void => {
  component.handleInput("\u001b[C");
};

const openActions = (component: ProfileWorkspaceComponent): void => component.handleInput("a");
const chooseDelete = (component: ProfileWorkspaceComponent): void => {
  openActions(component);
  component.handleInput("j");
  component.handleInput("j");
  component.handleInput("\r");
};

const modelEditor = (count = 3) => {
  const original: ReadonlyArray<ProfileCandidate> = Array.from({ length: count }, (_, index) => ({
    host: "local",
    runtime: "pi",
    model: `openai/model-${index}`,
    effort: "high",
    context: "fresh",
    writeIntent: "read-only",
    openaiFastMode: false,
    closeOnReport: true,
  }));
  let candidates = original;
  const inspection = () =>
    makeInspection({ revision: 1, overrides: { generalist: { candidates } } });
  const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>((_target, _profile, draft) => {
    candidates = draft.candidates;
    return Promise.resolve({ inspection: inspection() });
  });
  const component = new ProfileWorkspaceComponent(
    baseOptions({ inspection: inspection(), saveDraft }),
  );
  openFields(component);
  const selectField = (field: ProfileWorkspaceField): void => {
    const selected = component.getPosition().initialCandidateIndex;
    const rows = candidates.flatMap((candidate, candidateIndex) =>
      candidateFieldRows(candidate, "generalist", "high", undefined, false, {
        index: candidateIndex,
        count: candidates.length,
      }).map((row) => ({ ...row, candidateIndex })),
    );
    const index = rows.findIndex((row) => row.field === field && row.candidateIndex === selected);
    if (index < 0) throw new Error(`Missing field ${field}`);
    component.handleInput("g");
    component.handleInput("g");
    for (let step = 0; step < index; step += 1) component.handleInput("\u001b[B");
    component.handleInput("\r");
  };
  return { component, original, saveDraft, selectField, candidates: () => candidates };
};

describe("direct profile model actions", () => {
  effectTest("keeps the moved model selected across repeated moves and saves", function* () {
    const editor = modelEditor();
    const [first, second, third] = editor.original;
    editor.selectField("move-down");
    yield* step(settle);
    expect(editor.candidates()).toEqual([second, first, third]);

    editor.component.handleInput("\r");
    yield* step(settle);
    expect(editor.candidates()).toEqual([second, third, first]);

    editor.selectField("move-up");
    yield* step(settle);
    expect(editor.candidates()).toEqual([second, first, third]);
    editor.component.handleInput("\r");
    yield* step(settle);
    expect(editor.candidates()).toEqual(editor.original);

    editor.selectField("remove");
    editor.component.handleInput("\r");
    yield* step(settle);
    expect(editor.candidates()).toEqual([second, third]);
  });

  effectTest("does not save moves beyond the first or last position", function* () {
    const editor = modelEditor(2);
    editor.selectField("move-up");
    expect(editor.saveDraft).not.toHaveBeenCalled();
    editor.selectField("move-down");
    yield* step(settle);
    editor.saveDraft.mockClear();
    editor.component.handleInput("\r");
    expect(editor.saveDraft).not.toHaveBeenCalled();
    expect(editor.candidates()).toEqual([...editor.original].reverse());
  });

  effectTest(
    "requires confirmation, allows cancellation, and selects a remaining model after deletion",
    function* () {
      const editor = modelEditor();
      editor.selectField("move-down");
      yield* step(settle);
      editor.saveDraft.mockClear();
      editor.selectField("remove");
      expect(editor.saveDraft).not.toHaveBeenCalled();
      editor.component.handleInput("\u001b");
      expect(editor.saveDraft).not.toHaveBeenCalled();

      editor.selectField("remove");
      editor.component.handleInput("\r");
      yield* step(settle);
      expect(editor.candidates()).toEqual([editor.original[1], editor.original[2]]);
      editor.selectField("remove");
      editor.component.handleInput("\r");
      yield* step(settle);
      expect(editor.candidates()).toEqual([editor.original[2]]);
    },
  );

  effectTest(
    "omits single-model moves and disables the profile only after confirmed deletion",
    function* () {
      const editor = modelEditor(1);
      const fields = candidateFieldRows(editor.original[0]!, "generalist").map((row) => row.field);
      expect(fields).not.toContain("move-up");
      expect(fields).not.toContain("move-down");
      expect(fields).toContain("remove");
      editor.selectField("remove");
      expect(editor.saveDraft).not.toHaveBeenCalled();
      editor.component.handleInput("\r");
      yield* step(settle);
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
      yield* step(settle);
      expect(saveDraft).toHaveBeenCalledWith({ kind: "session" }, "generalist", {
        kind: "disabled",
        candidates: [],
      });
    },
  );

  it("does not expose numeric scope switching", () => {
    const close = vi.fn();
    const requestRender = vi.fn();
    const component = new ProfileWorkspaceComponent(baseOptions({ close, requestRender }));

    component.handleInput("1");
    component.handleInput("2");
    component.handleInput("3");

    expect(close).not.toHaveBeenCalled();
  });

  it("does not bind route mutations to raw keys", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    component.handleInput("d");
    expect(saveDraft).not.toHaveBeenCalled();
  });

  effectTest("requires confirmation for a destructive action chosen from the menu", function* () {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    chooseDelete(component);
    expect(saveDraft).not.toHaveBeenCalled();

    component.handleInput("x");
    expect(saveDraft).not.toHaveBeenCalled();
    component.handleInput("\r");
    yield* step(settle);
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("cancels destructive confirmation with Escape", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    chooseDelete(component);
    component.handleInput("\u001b");
    component.handleInput("\r");

    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("keeps an invalid clean Current Session baseline fail-closed", () => {
    const inspection = invalidBaselineInspection(false);
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
          inspection: inheritedInvalidProjectInspection(own),
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
    expect(component.render(120).join("\n")).toContain("Advanced");
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
      yield* step(settle);
      expect(current.session.overrides.generalist?.candidates).toEqual([]);
      expect(onInspection).toHaveBeenCalledOnce();
      component.handleInput("a");
      component.handleInput("j");
      component.handleInput("\r");
      expect(saveDraft).toHaveBeenCalledOnce();
      component.handleInput("\r");
      yield* step(settle);
      expect(current.session.overrides.generalist?.candidates).toEqual([candidate]);
      expect(editVisit.isEdited({ kind: "session" }, "generalist", current)).toBe(false);
    },
  );

  effectTest(
    "passes the exact saved declaration restore through the existing save boundary",
    function* () {
      const raw = {
        host: "local",
        runtime: "pi",
        model: "test/opening",
        effort: "high",
        context: "fresh",
        writeIntent: "read-only",
        closeOnReport: true,
      };
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
      yield* step(settle);
      component.handleInput("a");
      component.handleInput("j");
      component.handleInput("\r");
      component.handleInput("\r");
      yield* step(settle);
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
    yield* step(settle);
    expect(editVisit.isEdited({ kind: "session" }, "generalist", changed)).toBe(false);
    component.handleInput("a");
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.isBusy).toBe(true);
    expect(saveDraft).toHaveBeenCalledOnce();
  });
});

describe("profile workspace disposal", () => {
  effectTest(
    "lets submitted persistence settle but ignores every late UI continuation",
    function* () {
      const saveCell = Deferred.makeUnsafe<ProfileWorkspaceSaveResult>();
      let persistenceSettled = false;
      const save = Effect.runPromise(Deferred.await(saveCell)).then((result) => {
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
      yield* step(settle);
      expect(saveDraft).toHaveBeenCalledTimes(1);
      component.dispose();
      component.dispose();
      const rendersAtDispose = requestRender.mock.calls.length;
      component.handleInput("p");
      component.invalidate();
      expect(component.render(100)).toEqual([]);

      Deferred.doneUnsafe(saveCell, Effect.succeed({ inspection: makeInspection() }));
      yield* step(settle);
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
      const pickerCell = Deferred.makeUnsafe<PickerData>();
      const picker = Effect.runPromise(Deferred.await(pickerCell));
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
                  {
                    host: "local",
                    runtime: "codex",
                    model: "gpt-5.4",
                    effort: "high",
                    context: "fresh",
                    writeIntent: "read-only",
                    openaiFastMode: true,
                    closeOnReport: true,
                  },
                ],
              },
            },
          }),
          loadModelPicker: (_profile, _index, _candidate, signal) => {
            capturedSignal = signal;
            return picker;
          },
        }),
      );

      component.handleInput("\r");
      expect(capturedSignal).toBeDefined();
      component.dispose();
      expect(capturedSignal?.aborted).toBe(true);
      const rendersAtDispose = requestRender.mock.calls.length;
      Deferred.doneUnsafe(
        pickerCell,
        Effect.succeed({
          choices: [],
          current: "parent",
          context: {
            profile: "generalist",
            candidateIndex: 0,
            host: "local",
            runtime: "pi",
          },
        }),
      );
      return settle().then(() => {
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
        component.handleInput(shortcut === "e" ? "\u001b[A" : "\u001b[B");
        component.handleInput("\u001b[C");
        expect(saveDraft).not.toHaveBeenCalled();
        component.handleInput("\r");
        yield* step(settle);
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
    return settle().then(() => {
      expect(component.render(100).join("\n")).toContain("changed while you were editing");
    });
  });

  it("does not add reload state after editing a saved set", () => {
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        target: { kind: "profile-set", set: { scope: "global", name: "default" } },
      }),
    );

    chooseDelete(component);
    component.handleInput("\r");
    return settle().then(() => {
      const text = component.render(120).join("\n");
      expect(component.getPosition().initialProfile).toBe("generalist");
      expect(text).not.toContain("reload");
    });
  });
});
