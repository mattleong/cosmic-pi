import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  ProfileSetPickerComponent,
  type ProfileSetPickerAction,
} from "../src/settings/profile-set-picker.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import { profileSetPickerEntries } from "../src/settings/ui/profile-set-picker-model.ts";
import { renderProfileSetPicker } from "../src/settings/ui/profile-set-picker-render.ts";

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
  const global = decodeSubagentConfig(globalDocument, "global");
  const project = decodeSubagentConfig(projectDocument, "project");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: true,
    global,
    project,
  });
  return {
    config,
    global,
    project,
    globalDocument,
    projectDocument,
    session: makeSessionProfileSnapshot(config),
  };
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
  const global = decodeSubagentConfig(document, "global");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: false,
    globalConfigExists: true,
    projectConfigExists: false,
    global,
  });
  return {
    config,
    global,
    globalDocument: document,
    session: makeSessionProfileSnapshot(config),
  };
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
  const global = decodeSubagentConfig(inheritedGlobalDocument, "global");
  const project = decodeSubagentConfig(partialProjectDocument, "project");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: true,
    global,
    project,
  });
  return {
    config,
    global,
    project,
    globalDocument: inheritedGlobalDocument,
    projectDocument: partialProjectDocument,
    session: makeSessionProfileSnapshot(config),
  };
};

const malformedDefaultInspection = (scope: "global" | "project"): ProfileSettingsInspection => {
  const malformed = {
    version: 6,
    defaultProfileSet: 42,
    profileSets: { saved: { profiles: {} } },
  };
  if (scope === "global") {
    const global = decodeSubagentConfig(malformed, "global");
    const config = resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: true,
      globalConfigExists: true,
      projectConfigExists: false,
      global,
    });
    return {
      config,
      global,
      globalDocument: malformed,
      session: makeSessionProfileSnapshot(config),
    };
  }
  const global = decodeSubagentConfig(globalDocument, "global");
  const project = decodeSubagentConfig(malformed, "project");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: true,
    global,
    project,
  });
  return {
    config,
    global,
    project,
    globalDocument,
    projectDocument: malformed,
    session: makeSessionProfileSnapshot(config),
  };
};

const structurallyInvalidInspection = (): ProfileSettingsInspection => {
  const document = {
    version: 6,
    profileSets: {
      broken: null,
      valid: { profiles: {} },
    },
  };
  const global = decodeSubagentConfig(document, "global");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: false,
    globalConfigExists: true,
    projectConfigExists: false,
    global,
  });
  return {
    config,
    global,
    globalDocument: document,
    session: makeSessionProfileSnapshot(config),
  };
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

const joined = (component: ProfileSetPickerComponent) => component.render(120).join("\n");

describe("saved profile-set library", () => {
  it("groups Project and Global sets without presenting Session as a scope row", () => {
    const entries = profileSetPickerEntries(inspection(), true);
    expect(entries.map((entry) => entry.key)).toEqual([
      "project:common",
      "project:project",
      "global:common",
      "global:gold",
    ]);

    const text = joined(makePicker({ initialScope: "project" }).component);
    expect(text).toContain("Project");
    expect(text).toContain("Global");
    expect(text).toContain("Save Current Session");
    expect(text).not.toContain("Session scope");
    expect(text).not.toContain("Built-in routes");
  });

  it("keeps untrusted Project rows visible but unavailable", () => {
    const entries = profileSetPickerEntries(inspection(), false);
    expect(entries[0]).toMatchObject({ kind: "scope-note", key: "project:locked" });
    const picker = makePicker({ projectTrusted: false, initialScope: "project" });
    expect(joined(picker.component)).toContain("Project sets unavailable");

    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
  });

  it("opens explicit actions instead of overloading Enter", () => {
    const picker = makePicker();
    picker.component.handleInput("k");
    picker.component.handleInput("\r");
    const text = joined(picker.component);

    expect(picker.close).not.toHaveBeenCalled();
    expect(text).toContain("Choose an action");
    expect(text).toContain("Use in Current Session");
    expect(text).toContain("Edit saved set");
    expect(text).toContain("Make default for new sessions");
    expect(text).toContain("Copy");
    expect(text).toContain("Rename");
    expect(text).toContain("Delete");
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

  it("clears a scope default before the saved set can be deleted", () => {
    const project = makePicker({ initialScope: "project" });
    project.component.handleInput("\r");
    const projectMenu = joined(project.component);
    expect(projectMenu).toContain("Use Global default");
    expect(projectMenu).toContain("Delete · unavailable");

    project.component.handleInput("j");
    project.component.handleInput("j");
    expect(joined(project.component)).toContain("Use Global, then built-in profiles");
    project.component.handleInput("\r");
    expect(project.close).toHaveBeenCalledWith({
      action: "clear-scope-default",
      scope: "project",
    });

    const global = makePicker();
    global.component.handleInput("\r");
    global.component.handleInput("j");
    global.component.handleInput("j");
    expect(joined(global.component)).toContain("Use built-in profiles");
  });

  it("classifies inherited fail-closed routes as repairable saved-set profiles", () => {
    const value = inheritedInvalidInspection();
    const partial = profileSetPickerEntries(value, true).find(
      (entry) => entry.kind === "set" && entry.ref.scope === "project",
    );
    expect(partial).toMatchObject({
      invalid: true,
      repairable: true,
      invalidProfileCount: 1,
    });
    expect(partial?.description).toContain("1 invalid profile");

    const picker = makePicker({ value, initialScope: "project" });
    expect(joined(picker.component)).toContain("! fix profiles");
    picker.component.handleInput("\r");
    const text = joined(picker.component);
    expect(text).toContain("Fix invalid profiles");
    expect(text).not.toContain("Use in Current Session");
    expect(text).not.toContain("Make default for new sessions");
  });

  it("keeps route-invalid sets available for repair or deletion but not use or default", () => {
    const picker = makePicker({ value: invalidInspection(), projectTrusted: false });
    picker.component.handleInput("\r");
    const text = joined(picker.component);

    expect(text).toContain("Fix invalid profiles");
    expect(text).toContain("Delete");
    expect(text).not.toContain("Use in Current Session");
    expect(text).not.toContain("Make default for new sessions");
    expect(text).not.toContain("Copy");
    expect(text).not.toContain("Rename");

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
    expect(broken?.description).toContain("invalid structure");

    const picker = makePicker({ value, projectTrusted: false });
    picker.component.handleInput("\r");
    expect(joined(picker.component)).toContain("Cannot edit · unavailable");
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
    expect(joined(picker.component)).toContain("invalid structure");
  });

  it.each(["project", "global"] as const)(
    "shows and clears a malformed unnamed %s default selection",
    (scope) => {
      const value = malformedDefaultInspection(scope);
      const entry = profileSetPickerEntries(value, true).find(
        (candidate) => candidate.kind === "invalid-default" && candidate.scope === scope,
      );
      expect(entry).toMatchObject({
        kind: "invalid-default",
        scope,
        scopeDefault: true,
      });

      const picker = makePicker({ value, initialScope: scope });
      expect(joined(picker.component)).toContain("Invalid default setting");
      picker.component.handleInput("\r");
      expect(joined(picker.component)).toContain(
        scope === "project" ? "Use Global default" : "Use built-in defaults",
      );
      picker.component.handleInput("\r");
      expect(picker.close).toHaveBeenCalledWith({ action: "clear-scope-default", scope });
    },
  );

  it("requires Enter confirmation before deletion", () => {
    const picker = makePicker();
    picker.component.handleInput("k");
    picker.component.handleInput("\r");
    for (let index = 0; index < 5; index += 1) picker.component.handleInput("j");
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
    expect(joined(picker.component)).toContain("Enter confirms");

    picker.component.handleInput("x");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "delete",
      target: { scope: "global", name: "common" },
    });
  });

  it("prompts the controller to save Current Session as a new set", () => {
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

  it("keeps an empty search active when Enter has no saved set to open", () => {
    const picker = makePicker();
    picker.component.handleInput("/");
    for (const character of "no-such-set") picker.component.handleInput(character);
    picker.component.handleInput("\r");

    const text = joined(picker.component);
    expect(text).toContain("Search /no-such-set");
    expect(text).toContain("No saved sets match this search.");
    expect(text).not.toContain("Choose an action");
    expect(picker.close).not.toHaveBeenCalled();
  });

  it("shows the selected saved-set action at an overall height of five", () => {
    const picker = makePicker({ height: 5 });
    picker.component.handleInput("\r");

    const lines = picker.component.render(80);
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("Use in Current Session");
  });

  it("keeps search and disposal bounded", () => {
    const picker = makePicker();
    picker.component.handleInput("/");
    for (const character of "common") picker.component.handleInput(character);
    expect(joined(picker.component)).toContain("Search /common");
    picker.component.handleInput("\r");
    expect(joined(picker.component)).toContain("Choose an action");

    picker.component.dispose();
    picker.component.handleInput("\r");
    expect(picker.component.render(100)).toEqual([]);
  });

  it("keeps all terminal sizes within exact width and height bounds", () => {
    const entries = profileSetPickerEntries(inspection(), true);
    for (const [width, height] of [
      [120, 20],
      [80, 10],
      [40, 5],
      [3, 4],
      [1, 2],
      [0, 4],
    ] as const) {
      const lines = renderProfileSetPicker(
        {
          entries,
          selectedIndex: entries.length - 1,
          query: "",
          searching: false,
          projectTrusted: true,
        },
        { theme, width, height },
      );
      if (width === 0) expect(lines).toEqual([]);
      else {
        expect(lines).toHaveLength(height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });
});
