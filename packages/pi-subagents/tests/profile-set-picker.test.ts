import { describe, expect, it, vi } from "vitest";
import {
  inheritedInvalidInspection,
  INVALID_ROUTE,
  makeProfileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import { declaredCandidate as candidate } from "./fixtures/profiles.ts";
import {
  ProfileSetPickerComponent,
  savedSetMenuChoices,
  type ProfileSetPickerAction,
} from "../src/settings/profile-set-picker.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import { profileSetPickerEntries } from "../src/settings/ui/profile-set-picker-model.ts";

const globalDocument = {
  version: 6,
  defaultProfileSet: "gold",
  profileSets: {
    common: { profiles: {} },
    gold: { profiles: {} },
  },
};

const projectDocument = {
  version: 6,
  defaultProfileSet: "project",
  profileSets: {
    common: { profiles: {} },
    project: { profiles: {} },
  },
};

const inspection = (): ProfileSettingsInspection => {
  return makeProfileSettingsInspection({
    globalDocument,
    projectDocument,
    projectTrusted: true,
  });
};

const invalidInspection = (): ProfileSettingsInspection =>
  makeProfileSettingsInspection({
    globalDocument: {
      version: 6,
      profileSets: { broken: { profiles: { worker: INVALID_ROUTE } }, valid: { profiles: {} } },
    },
    projectTrusted: false,
  });

const malformedDefaultInspection = (scope: "global" | "project"): ProfileSettingsInspection => {
  const malformed = {
    version: 6,
    defaultProfileSet: 42,
    profileSets: { saved: { profiles: {} } },
  };
  if (scope === "global") {
    return makeProfileSettingsInspection({
      globalDocument: malformed,
      projectTrusted: true,
    });
  }
  return makeProfileSettingsInspection({
    globalDocument,
    projectDocument: malformed,
    projectTrusted: true,
  });
};

const structurallyInvalidInspection = (): ProfileSettingsInspection => {
  const document = {
    version: 6,
    profileSets: {
      broken: null,
      valid: { profiles: {} },
    },
  };
  return makeProfileSettingsInspection({
    globalDocument: document,
    projectTrusted: false,
  });
};

const makePicker = (
  options: {
    readonly value?: ProfileSettingsInspection;
    readonly projectTrusted?: boolean;
    readonly height?: number;
  } = {},
) => {
  const close = vi.fn<(action: ProfileSetPickerAction | undefined) => void>();
  const component = new ProfileSetPickerComponent({
    theme: plainTheme,
    inspection: options.value ?? inspection(),
    projectTrusted: options.projectTrusted ?? true,
    getHeight: () => options.height ?? 30,
    requestRender: vi.fn(),
    close,
  });
  return { close, component };
};

describe("saved profile-set library", () => {
  it("previews resolved routes with ordered models, inheritance, disabled and invalid states", () => {
    const value = makeProfileSettingsInspection({
      globalDocument: {
        version: 6,
        defaultProfileSet: "base",
        profileSets: {
          base: {
            profiles: {
              scout: [candidate("test/primary"), candidate("test/fallback", { effort: "low" })],
              worker: "disabled",
              reviewer: [candidate("test/broken", { effort: "impossible" })],
            },
          },
        },
      },
      projectDocument: { version: 6, profileSets: { partial: { profiles: {} } } },
      projectTrusted: true,
    });
    const entry = profileSetPickerEntries(value, true).find(
      (entry) => entry.key === "project:partial",
    );
    if (entry?.kind !== "set") throw new Error("Missing project set");
    expect(entry.preview.find((profile) => profile.id === "scout")).toMatchObject({
      source: "global",
      inherited: true,
      status: "configured",
      candidates: [
        { model: "test/primary", effort: "high" },
        { model: "test/fallback", effort: "low" },
      ],
    });
    expect(entry.preview.find((profile) => profile.id === "worker")).toMatchObject({
      inherited: true,
      status: "disabled",
      candidates: [],
    });
    expect(entry.preview.find((profile) => profile.id === "reviewer")).toMatchObject({
      source: "global-invalid",
      status: "invalid",
      candidates: [],
    });
    expect(entry.preview.find((profile) => profile.id === "planner")).toMatchObject({
      source: "builtin",
      inherited: true,
      status: "configured",
    });
  });

  it("updates the preview on navigation, search and inspection refresh without activating a set", () => {
    const value = (model: string) =>
      makeProfileSettingsInspection({
        globalDocument: {
          version: 6,
          profileSets: {
            alpha: { profiles: { scout: [candidate("test/alpha-model")] } },
            beta: { profiles: { scout: [candidate(model)] } },
          },
        },
        projectTrusted: false,
      });
    const { component, close } = makePicker({
      value: value("test/beta-model"),
      projectTrusted: false,
    });
    expect(component.render(150).join("\n")).toContain("test/alpha-model");
    component.handleInput("j");
    expect(component.render(150).join("\n")).toContain("test/beta-model");
    expect(component.render(150).join("\n")).not.toContain("test/alpha-model");
    component.handleInput("/");
    for (const key of "alpha") component.handleInput(key);
    expect(component.render(150).join("\n")).toContain("test/alpha-model");
    component.handleInput("\u001b");
    component.handleInput("j");
    component.updateInspection(value("test/refreshed-model"), false);
    expect(component.render(180).join("\n")).toContain("test/refreshed-model");
    expect(component.render(80).join("\n")).toContain("test/refreshed-model");
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps untrusted Project entries visible but unavailable", () => {
    const entries = profileSetPickerEntries(inspection(), false);
    expect(entries[0]).toMatchObject({ kind: "scope-note", key: "project:locked" });

    const picker = makePicker({ projectTrusted: false });
    picker.component.handleInput("g");
    picker.component.handleInput("g");
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
  });

  it("emits Use, Edit, and Make default as distinct actions", () => {
    const use = makePicker();
    use.component.handleInput("u");
    expect(use.close).toHaveBeenCalledWith({
      action: "use-current",
      target: { scope: "project", name: "project" },
    });

    const edit = makePicker();
    edit.component.handleInput("\r");
    expect(edit.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "project", name: "project" },
    });

    const makeDefault = makePicker();
    makeDefault.component.handleInput("k");
    makeDefault.component.handleInput("?");
    makeDefault.component.handleInput("\r");
    expect(makeDefault.close).toHaveBeenCalledWith({
      action: "make-default",
      target: { scope: "project", name: "common" },
    });
  });

  it("clears a scope default before its selected set can be deleted", () => {
    const picker = makePicker();
    picker.component.handleInput("?");
    picker.component.handleInput("\r");

    expect(picker.close).toHaveBeenCalledWith({
      action: "clear-scope-default",
      scope: "project",
    });
  });

  it("offers complete More actions and keeps a default set's Delete unavailable", () => {
    const menu = (value: ProfileSettingsInspection, key: string) => {
      const entry = profileSetPickerEntries(value, true).find((candidate) => candidate.key === key);
      if (entry?.kind !== "set" && entry?.kind !== "invalid-default") throw new Error(key);
      return savedSetMenuChoices(entry).map(({ payload, enabled }) => [payload, enabled !== false]);
    };
    const common = { scope: "project", name: "common" } as const;
    expect(menu(inspection(), "project:common")).toEqual([
      [{ action: "make-default", target: common }, true],
      [{ action: "copy", source: common }, true],
      [{ action: "rename", target: common }, true],
      [{ action: "delete", target: common }, true],
    ]);
    const gold = { scope: "global", name: "gold" } as const;
    expect(menu(inspection(), "global:gold")).toEqual([
      [{ action: "clear-scope-default", scope: "global" }, true],
      [{ action: "copy", source: gold }, true],
      [{ action: "rename", target: gold }, true],
      [{ action: "delete", target: gold }, false],
    ]);
    expect(menu(invalidInspection(), "global:broken")).toEqual([
      [{ action: "delete", target: { scope: "global", name: "broken" } }, true],
    ]);
    expect(menu(malformedDefaultInspection("global"), "global:invalid-default")).toEqual([
      [{ action: "clear-scope-default", scope: "global" }, true],
    ]);
  });

  it("classifies inherited fail-closed routes as repairable", () => {
    const value = inheritedInvalidInspection();
    const partial = profileSetPickerEntries(value, true).find(
      (entry) => entry.kind === "set" && entry.ref.scope === "project",
    );

    expect(partial).toMatchObject({ invalid: true, repairable: true });
    if (partial?.kind !== "set") throw new Error("Missing project set");
    expect(partial.preview.filter((profile) => profile.status === "invalid")).toHaveLength(1);
  });

  it("blocks Use for invalid sets without preventing repair", () => {
    const picker = makePicker({ value: invalidInspection(), projectTrusted: false });
    picker.component.handleInput("u");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "broken" },
    });
  });

  it("cancels More without changing the selected set", () => {
    const picker = makePicker();
    picker.component.handleInput("?");
    picker.component.handleInput("j");
    picker.component.handleInput("\u001b[C");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\u001b");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "project", name: "project" },
    });
  });

  it("does not offer editor repair for structurally invalid sets", () => {
    const value = structurallyInvalidInspection();
    const broken = profileSetPickerEntries(value, false).find(
      (entry) => entry.kind === "set" && entry.ref.name === "broken",
    );
    expect(broken).toMatchObject({ invalid: true, repairable: false });

    const picker = makePicker({ value, projectTrusted: false });
    picker.component.handleInput("\r");
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
  });

  it.each(["project", "global"] as const)(
    "clears a malformed unnamed %s default selection",
    (scope) => {
      const value = malformedDefaultInspection(scope);
      const entry = profileSetPickerEntries(value, true).find(
        (candidate) => candidate.kind === "invalid-default" && candidate.scope === scope,
      );
      expect(entry).toMatchObject({ kind: "invalid-default", scope, scopeDefault: true });

      const picker = makePicker({ value });
      picker.component.handleInput("\r");
      picker.component.handleInput("\r");
      expect(picker.close).toHaveBeenCalledWith({ action: "clear-scope-default", scope });
    },
  );

  it("never saves Current Session from the library", () => {
    for (const projectTrusted of [true, false]) {
      const picker = makePicker({ projectTrusted });
      picker.component.handleInput("s");
      expect(picker.close).not.toHaveBeenCalled();
    }
  });

  it("opens More through the library action shortcut", () => {
    const picker = makePicker();
    picker.component.handleInput("a");
    expect(picker.component.hasOverlay).toBe(true);
    picker.component.handleInput("\u001b");
    expect(picker.component.hasOverlay).toBe(false);
    // A refresh retires a menu built for the previous inspection.
    picker.component.handleInput("a");
    picker.component.updateInspection(inspection(), true);
    expect(picker.component.hasOverlay).toBe(false);
    expect(picker.close).not.toHaveBeenCalled();
  });

  it("does not activate a saved-set action when filtering has no match", () => {
    const picker = makePicker();
    picker.component.handleInput("/");
    for (const character of "no-such-set") picker.component.handleInput(character);
    picker.component.handleInput("\r");

    expect(picker.close).not.toHaveBeenCalled();
  });

  it.each([5, 6, 7, 8, 9])("keeps the search selection visible at height %s", (height) => {
    const picker = makePicker({ height });
    picker.component.handleInput("/");
    picker.component.handleInput("c");
    picker.component.handleInput("\u001b[B");
    const rendered = picker.component.render(120).join("\n");
    picker.component.handleInput("\r");
    const action = picker.close.mock.calls[0]?.[0];
    expect(action?.action).toBe("edit");
    if (action?.action !== "edit") throw new Error("Expected an editable search selection");
    expect(rendered).toContain(action.target.name);
  });

  it("ignores input and rendering after disposal", () => {
    const picker = makePicker();
    picker.component.handleInput("/");
    for (const character of "common") picker.component.handleInput(character);

    picker.component.dispose();
    picker.component.handleInput("\r");
    expect(picker.component.render(100)).toEqual([]);
    expect(picker.close).not.toHaveBeenCalled();
  });
});
