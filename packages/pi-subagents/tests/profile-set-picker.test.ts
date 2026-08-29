import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  ProfileSetPickerComponent,
  type ProfileSetPickerAction,
} from "../src/settings/profile-set-picker.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import {
  initialProfileSetPickerIndex,
  profileSetPickerEntries,
} from "../src/settings/ui/profile-set-picker-model.ts";
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
  profileSets: {
    common: { profiles: {} },
    project: { profiles: {} },
  },
};

const inspection = (projectDefault?: string): ProfileSettingsInspection => {
  const projectInput =
    projectDefault === undefined
      ? projectDocument
      : { ...projectDocument, defaultProfileSet: projectDefault };
  const global = decodeSubagentConfig(globalDocument, "global");
  const project = decodeSubagentConfig(projectInput, "project");
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
    projectDocument: projectInput,
    session: makeSessionProfileSnapshot(config),
  };
};

// SAFETY: Component action tests do not render theme-dependent output.
const theme = {} as Theme;
// SAFETY: The renderer uses only the two Theme methods implemented by this projection fixture.
const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

describe("profile-set picker", () => {
  it("combines scope-local sets without conflating colliding names", () => {
    const entries = profileSetPickerEntries(inspection(), true);
    expect(entries.map((entry) => entry.label)).toEqual([
      "[P] Inherit global",
      "[P] common",
      "[P] project",
      "[G] Built-in routes",
      "[G] common",
      "[G] gold",
    ]);
    expect(entries.filter((entry) => entry.current).map((entry) => entry.label)).toEqual([
      "[G] gold",
    ]);
    expect(entries.find((entry) => entry.key === "project:common")).toMatchObject({
      scope: "project",
      ref: { scope: "project", name: "common" },
    });
    expect(entries.find((entry) => entry.key === "global:common")).toMatchObject({
      scope: "global",
      ref: { scope: "global", name: "common" },
    });
  });

  it("marks exactly the selected project set current", () => {
    const entries = profileSetPickerEntries(inspection("project"), true);
    expect(entries.filter((entry) => entry.current).map((entry) => entry.label)).toEqual([
      "[P] project",
    ]);
    expect(initialProfileSetPickerIndex(entries, "project")).toBe(
      entries.findIndex((entry) => entry.label === "[P] project"),
    );
  });

  it("represents malformed defaults without exposing a raw name or claiming built-ins", () => {
    const global = decodeSubagentConfig(
      { version: 6, defaultProfileSet: 42, profileSets: { valid: { profiles: {} } } },
      "global",
    );
    const config = resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: false,
      globalConfigExists: true,
      projectConfigExists: false,
      global,
    });
    const malformedInspection: ProfileSettingsInspection = {
      config,
      global,
      globalDocument: {
        version: 6,
        defaultProfileSet: 42,
        profileSets: { valid: { profiles: {} } },
      },
      session: makeSessionProfileSnapshot(config),
    };
    const entries = profileSetPickerEntries(malformedInspection, false);
    expect(entries.filter((entry) => entry.current)).toEqual([
      expect.objectContaining({ kind: "invalid-default", label: "[G] Invalid default" }),
    ]);
    const close = vi.fn();
    const component = new ProfileSetPickerComponent({
      theme,
      inspection: malformedInspection,
      projectTrusted: false,
      reloadRequired: false,
      getHeight: () => 40,
      requestRender: vi.fn(),
      close,
    });
    component.handleInput("\r");
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps the selected entry visible when scope headings consume rows", () => {
    const entries = profileSetPickerEntries(inspection(), true);
    const lines = renderProfileSetPicker(
      {
        entries,
        selectedIndex: entries.length - 1,
        query: "",
        searching: false,
        reloadRequired: false,
        sessionOverrideCount: 0,
      },
      { theme: renderTheme, width: 100, height: 10 },
    );
    expect(lines.join("\n")).toContain("> [G] gold");
  });

  it("keeps copy and create actions within the selected scope", () => {
    const copied: ProfileSetPickerAction[] = [];
    const copyComponent = new ProfileSetPickerComponent({
      theme,
      inspection: inspection(),
      projectTrusted: true,
      initialScope: "global",
      reloadRequired: false,
      getHeight: () => 40,
      requestRender: vi.fn(),
      close: (action) => {
        if (action) copied.push(action);
      },
    });
    copyComponent.handleInput("c");
    expect(copied).toEqual([{ action: "copy", source: { scope: "global", name: "gold" } }]);

    const created: ProfileSetPickerAction[] = [];
    const createComponent = new ProfileSetPickerComponent({
      theme,
      inspection: inspection(),
      projectTrusted: true,
      initialScope: "project",
      reloadRequired: false,
      getHeight: () => 40,
      requestRender: vi.fn(),
      close: (action) => {
        if (action) created.push(action);
      },
    });
    createComponent.handleInput("n");
    expect(created).toEqual([{ action: "create", scope: "project" }]);
  });
});
