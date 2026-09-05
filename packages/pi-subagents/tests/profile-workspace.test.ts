import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { effectTest, step } from "./support/effect-test.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import type { SessionProfileOverrideSeed } from "../src/profiles/session-overrides.ts";
import { inheritSessionDraft } from "../src/settings/profile-route-editor.ts";
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
  component.handleInput("f");
  component.handleInput("\r");
};

const openActions = (component: ProfileWorkspaceComponent): void => {
  openFields(component);
  component.handleInput("G");
  component.handleInput("\r");
};

const chooseDisable = (component: ProfileWorkspaceComponent): void => {
  openActions(component);
  // Add fallback, copy route option, remove route option, disable profile.
  for (let index = 0; index < 3; index += 1) component.handleInput("j");
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
    const rows = candidateFieldRows(original[0]!, "generalist", "high", undefined, false, {
      index: 0,
      count: candidates.length,
    });
    const index = rows.findIndex((row) => row.field === field);
    if (index < 0) throw new Error(`Missing field ${field}`);
    component.handleInput("g");
    component.handleInput("g");
    for (let step = 0; step < index; step += 1) component.handleInput("j");
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
  it("honors configured confirmation and cancellation without bypassing the warning", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        saveDraft,
        matchesKeybinding: (data, id) =>
          (id === "tui.select.confirm" && data === "\u0018") ||
          (id === "tui.select.cancel" && data === "\u0014"),
      }),
    );
    chooseDisable(component);
    component.handleInput("\u0014");
    expect(saveDraft).not.toHaveBeenCalled();
    chooseDisable(component);
    expect(saveDraft).not.toHaveBeenCalled();
    component.handleInput("\u0018");
    expect(saveDraft).toHaveBeenCalledWith({ kind: "session" }, "generalist", {
      kind: "disabled",
      candidates: [],
    });
  });

  it("opens the saved-set library from p and preserves the selected profile", () => {
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({ initialProfile: "planner", close }),
    );

    component.handleInput("p");

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sets", profile: "planner" }),
    );
  });

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

  it("requires confirmation for a destructive action chosen from the menu", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    chooseDisable(component);
    expect(saveDraft).not.toHaveBeenCalled();

    component.handleInput("x");
    expect(saveDraft).not.toHaveBeenCalled();
    component.handleInput("\r");
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("cancels destructive confirmation with Escape", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    chooseDisable(component);
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

  it("does not offer removal for an inherited-invalid Project route without a declaration", () => {
    const inspection = inheritedInvalidProjectInspection(false);
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        inspection,
        target: { kind: "profile-set", set: { scope: "project", name: "partial" } },
      }),
    );

    expect(component.render(120).join("\n")).toContain("invalid, won't run until fixed");
    openActions(component);
    const actions = component.render(120).join("\n");
    expect(actions).toContain("Add Primary");
    expect(actions).not.toContain("Remove saved profile settings");
  });

  it("removes an own invalid Project declaration", () => {
    const inspection = inheritedInvalidProjectInspection(true);
    const target = {
      kind: "profile-set" as const,
      set: { scope: "project" as const, name: "partial" },
    };
    const restored = inheritedInvalidProjectInspection(false);
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: restored }));
    const component = new ProfileWorkspaceComponent(baseOptions({ inspection, target, saveDraft }));

    openActions(component);
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    component.handleInput("\r");

    expect(saveDraft).toHaveBeenCalledWith(target, "generalist", {
      kind: "inherit",
      candidates: [],
    });
    return settle();
  });

  it("undoes a repaired session setting to its inherited invalid route", () => {
    const inspection = invalidBaselineInspection(true);
    const restored = invalidBaselineInspection(false);
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: restored }));
    const component = new ProfileWorkspaceComponent(baseOptions({ inspection, saveDraft }));

    openActions(component);
    for (let index = 0; index < 4; index += 1) component.handleInput("j");
    component.handleInput("\r");
    component.handleInput("\r");
    expect(saveDraft).toHaveBeenCalledWith({ kind: "session" }, "generalist", {
      kind: "inherit",
      candidates: [],
    });
    return settle();
  });

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
    for (let index = 0; index < 4; index += 1) component.handleInput("j");

    component.handleInput("\r");

    expect(saveDraft).not.toHaveBeenCalled();
    expect(component.render(120).join("\n")).toContain("Advanced");
  });
});

describe("profile workspace disposal", () => {
  it("lets submitted persistence settle but ignores every late UI continuation", () => {
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

    chooseDisable(component);
    component.handleInput("\r");
    expect(saveDraft).toHaveBeenCalledTimes(1);
    component.dispose();
    component.dispose();
    const rendersAtDispose = requestRender.mock.calls.length;
    component.handleInput("p");
    component.invalidate();
    expect(component.render(100)).toEqual([]);

    Deferred.doneUnsafe(saveCell, Effect.succeed({ inspection: makeInspection() }));
    return settle().then(() => {
      expect(persistenceSettled).toBe(true);
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(close).not.toHaveBeenCalled();
      expect(onDispose).toHaveBeenCalledTimes(1);
    });
  });

  it("aborts model loading and ignores its late result", () => {
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
        loadModelPicker: (_profile, _index, _candidate, signal) => {
          capturedSignal = signal;
          return picker;
        },
      }),
    );

    openFields(component);
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
    });
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

    chooseDisable(component);
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

    chooseDisable(component);
    component.handleInput("\r");
    return settle().then(() => {
      const text = component.render(120).join("\n");
      expect(text).toContain("Current Session unchanged");
      expect(text).not.toContain("reload");
    });
  });
});
