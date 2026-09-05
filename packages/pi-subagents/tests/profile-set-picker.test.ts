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
  it("keeps untrusted Project entries visible but unavailable", () => {
    const entries = profileSetPickerEntries(inspection(), false);
    expect(entries[0]).toMatchObject({ kind: "scope-note", key: "project:locked" });

    const picker = makePicker({ projectTrusted: false, initialScope: "project" });
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
  });

  it("emits Use, Edit, and Make default as distinct actions", () => {
    const use = makePicker();
    use.component.handleInput("\r");
    use.component.handleInput("\r");
    expect(use.close).toHaveBeenCalledWith({
      action: "use-current",
      target: { scope: "global", name: "gold" },
    });

    const edit = makePicker();
    edit.component.handleInput("\r");
    edit.component.handleInput("j");
    edit.component.handleInput("\r");
    expect(edit.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });

    const makeDefault = makePicker();
    makeDefault.component.handleInput("k");
    makeDefault.component.handleInput("\r");
    makeDefault.component.handleInput("j");
    makeDefault.component.handleInput("j");
    makeDefault.component.handleInput("\r");
    expect(makeDefault.close).toHaveBeenCalledWith({
      action: "make-default",
      target: { scope: "global", name: "common" },
    });
  });

  it("clears a scope default before its selected set can be deleted", () => {
    const picker = makePicker({ initialScope: "project" });
    picker.component.handleInput("\r");
    picker.component.handleInput("j");
    picker.component.handleInput("j");
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
    picker.component.handleInput("\r");
    for (let index = 0; index < 5; index += 1) picker.component.handleInput("j");
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

  it("prompts the controller to save the session in an eligible scope", () => {
    const project = makePicker({ initialScope: "project" });
    project.component.handleInput("s");
    expect(project.close).toHaveBeenCalledWith({
      action: "save-session",
      preferredScope: "project",
    });

    const untrusted = makePicker({ projectTrusted: false, initialScope: "project" });
    untrusted.component.handleInput("s");
    expect(untrusted.close).toHaveBeenCalledWith({
      action: "save-session",
      preferredScope: "global",
    });
  });

  it("does not activate a saved-set action when filtering has no match", () => {
    const picker = makePicker();
    picker.component.handleInput("/");
    for (const character of "no-such-set") picker.component.handleInput(character);
    picker.component.handleInput("\r");

    expect(picker.close).not.toHaveBeenCalled();
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
