import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import {
  ProfileSetPickerComponent,
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

const invalidInspection = (): ProfileSettingsInspection => {
  const document = {
    version: 6,
    profileSets: {
      broken: {
        profiles: {
          worker: {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "impossible",
            context: "fresh",
            writeIntent: "writer",
          },
        },
      },
      valid: { profiles: {} },
    },
  };
  return makeProfileSettingsInspection({
    globalDocument: document,
    projectTrusted: false,
  });
};

const inheritedInvalidInspection = (): ProfileSettingsInspection => {
  const inheritedGlobalDocument = {
    version: 6,
    defaultProfileSet: "broken",
    profileSets: {
      broken: {
        profiles: {
          worker: {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "impossible",
            context: "fresh",
            writeIntent: "writer",
          },
        },
      },
    },
  };
  const partialProjectDocument = {
    version: 6,
    defaultProfileSet: "partial",
    profileSets: { partial: { profiles: {} } },
  };
  return makeProfileSettingsInspection({
    globalDocument: inheritedGlobalDocument,
    projectDocument: partialProjectDocument,
    projectTrusted: true,
  });
};

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

// SAFETY: The component and renderer use only the Theme methods implemented by this fixture.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const makePicker = (
  options: {
    readonly value?: ProfileSettingsInspection;
    readonly projectTrusted?: boolean;
    readonly initialScope?: "global" | "project";
    readonly height?: number;
  } = {},
) => {
  const close = vi.fn<(action: ProfileSetPickerAction | undefined) => void>();
  const component = new ProfileSetPickerComponent({
    theme,
    inspection: options.value ?? inspection(),
    projectTrusted: options.projectTrusted ?? true,
    initialScope: options.initialScope ?? "global",
    getHeight: () => options.height ?? 30,
    requestRender: vi.fn(),
    close,
  });
  return { close, component };
};

describe("saved profile-set library", () => {
  const candidate = (model: string, effort = "high") => ({
    host: "local",
    runtime: "pi",
    model,
    effort,
    context: "fresh",
    writeIntent: "read-only",
    closeOnReport: true,
  });

  it("previews resolved routes with ordered models, inheritance, disabled and invalid states", () => {
    const value = makeProfileSettingsInspection({
      globalDocument: {
        version: 6,
        defaultProfileSet: "base",
        profileSets: {
          base: {
            profiles: {
              scout: [candidate("test/primary"), candidate("test/fallback", "low")],
              worker: "disabled",
              reviewer: [candidate("test/broken", "impossible")],
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

    const picker = makePicker({ projectTrusted: false, initialScope: "project" });
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
      target: { scope: "global", name: "gold" },
    });

    const edit = makePicker();
    edit.component.handleInput("\r");
    expect(edit.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });

    const makeDefault = makePicker();
    makeDefault.component.handleInput("k");
    makeDefault.component.handleInput("?");
    makeDefault.component.handleInput("\r");
    expect(makeDefault.close).toHaveBeenCalledWith({
      action: "make-default",
      target: { scope: "global", name: "common" },
    });
  });

  it("clears a scope default before its selected set can be deleted", () => {
    const picker = makePicker({ initialScope: "project" });
    picker.component.handleInput("?");
    picker.component.handleInput("\r");

    expect(picker.close).toHaveBeenCalledWith({
      action: "clear-scope-default",
      scope: "project",
    });
  });

  it("classifies inherited fail-closed routes as repairable", () => {
    const value = inheritedInvalidInspection();
    const partial = profileSetPickerEntries(value, true).find(
      (entry) => entry.kind === "set" && entry.ref.scope === "project",
    );

    expect(partial).toMatchObject({ invalid: true, repairable: true, invalidProfileCount: 1 });
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
    picker.component.handleInput("\u001b");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });
  });

  it("routes an invalid but repairable set to editing", () => {
    const picker = makePicker({ value: invalidInspection(), projectTrusted: false });
    picker.component.handleInput("\r");
    picker.component.handleInput("\r");

    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "broken" },
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

      const picker = makePicker({ value, initialScope: scope });
      picker.component.handleInput("\r");
      picker.component.handleInput("\r");
      expect(picker.close).toHaveBeenCalledWith({ action: "clear-scope-default", scope });
    },
  );

  it("requires a separate confirmation before deletion", () => {
    const picker = makePicker();
    picker.component.handleInput("k");
    picker.component.handleInput("?");
    for (let index = 0; index < 3; index += 1) picker.component.handleInput("j");
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\x1b[13;1:2u");
    expect(picker.close).not.toHaveBeenCalled();

    picker.component.handleInput("x");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "delete",
      target: { scope: "global", name: "common" },
    });
  });

  it("never saves Current Session from the library", () => {
    for (const projectTrusted of [true, false]) {
      const picker = makePicker({ projectTrusted, initialScope: "project" });
      picker.component.handleInput("s");
      expect(picker.close).not.toHaveBeenCalled();
    }
  });

  it("opens More through the library action shortcut", () => {
    const picker = makePicker({ initialScope: "global" });
    picker.component.handleInput("a");
    expect(picker.component.hasOverlay).toBe(true);
    picker.component.handleInput("\u001b");
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
