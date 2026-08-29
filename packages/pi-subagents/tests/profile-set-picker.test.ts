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

const makePicker = (
  options: {
    readonly value?: ProfileSettingsInspection;
    readonly projectTrusted?: boolean;
    readonly initialScope?: "global" | "project";
    readonly reloadRequired?: boolean;
  } = {},
) => {
  const close = vi.fn<(action: ProfileSetPickerAction | undefined) => void>();
  const component = new ProfileSetPickerComponent({
    theme: renderTheme,
    inspection: options.value ?? inspection(),
    projectTrusted: options.projectTrusted ?? true,
    initialScope: options.initialScope ?? "global",
    reloadRequired: options.reloadRequired ?? false,
    getHeight: () => 40,
    requestRender: vi.fn(),
    close,
  });
  return { close, component };
};

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
    component.handleInput("u");
    expect(close).not.toHaveBeenCalled();
  });

  it("edits a valid named set with Enter or forward navigation", () => {
    const enter = makePicker();
    enter.component.handleInput("\r");
    expect(enter.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });

    const forward = makePicker();
    forward.component.handleInput("l");
    expect(forward.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });
  });

  it("requires Enter to confirm activation and ignores unrelated confirmation keys", () => {
    const picker = makePicker();
    picker.component.handleInput("u");
    expect(picker.close).not.toHaveBeenCalled();

    picker.component.handleInput("z");
    expect(picker.close).not.toHaveBeenCalled();

    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "use",
      entry: expect.objectContaining({
        kind: "set",
        ref: { scope: "global", name: "gold" },
      }),
    });
  });

  it("does not claim reload is needed when the saved Project set is already active", () => {
    const picker = makePicker({ value: inspection("project"), initialScope: "project" });
    picker.component.handleInput("u");

    const output = picker.component.render(100).join("\n");
    expect(output).toContain("Reload  Not required");
    expect(output).not.toContain("Required after activation");
  });

  it("cancels activation confirmation with Esc", () => {
    const picker = makePicker();
    picker.component.handleInput("u");
    picker.component.handleInput("\u001b");
    expect(picker.close).not.toHaveBeenCalled();

    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });
  });

  it("confirms deletion with Enter and cancels it with Esc", () => {
    const confirmed = makePicker();
    confirmed.component.handleInput("k");
    confirmed.component.handleInput("x");
    expect(confirmed.close).not.toHaveBeenCalled();
    confirmed.component.handleInput("\r");
    expect(confirmed.close).toHaveBeenCalledWith({
      action: "delete",
      target: { scope: "global", name: "common" },
    });

    const canceled = makePicker();
    canceled.component.handleInput("k");
    canceled.component.handleInput("x");
    canceled.component.handleInput("\u001b");
    expect(canceled.close).not.toHaveBeenCalled();
    canceled.component.handleInput("\r");
    expect(canceled.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "common" },
    });
  });

  it("guards the default set from deletion", () => {
    const picker = makePicker();
    picker.component.handleInput("x");
    expect(picker.close).not.toHaveBeenCalled();
    expect(picker.component.render(100).join("\n")).toContain("default set");

    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "gold" },
    });
  });

  it("does not edit invalid, built-in, or inherit entries", () => {
    const global = decodeSubagentConfig(
      {
        version: 6,
        defaultProfileSet: "missing",
        profileSets: { valid: { profiles: {} } },
      },
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
    const invalidInspection: ProfileSettingsInspection = {
      config,
      global,
      globalDocument: {
        version: 6,
        defaultProfileSet: "missing",
        profileSets: { valid: { profiles: {} } },
      },
      session: makeSessionProfileSnapshot(config),
    };
    const invalid = makePicker({ value: invalidInspection, projectTrusted: false });
    invalid.component.handleInput("\r");
    invalid.component.handleInput("u");
    expect(invalid.close).not.toHaveBeenCalled();
    expect(invalid.component.render(100).join("\n")).toContain("invalid set");

    const builtIn = makePicker();
    builtIn.component.handleInput("k");
    builtIn.component.handleInput("k");
    builtIn.component.handleInput("\r");
    expect(builtIn.close).not.toHaveBeenCalled();
    expect(builtIn.component.render(100).join("\n")).toContain("no editable set");

    const inherit = makePicker({ initialScope: "project" });
    inherit.component.handleInput("\r");
    expect(inherit.close).not.toHaveBeenCalled();
    expect(inherit.component.render(100).join("\n")).toContain("no editable set");
  });

  it("keeps built-in and inherit entries activatable through explicit confirmation", () => {
    const builtIn = makePicker();
    builtIn.component.handleInput("k");
    builtIn.component.handleInput("k");
    builtIn.component.handleInput("u");
    builtIn.component.handleInput("\r");
    expect(builtIn.close).toHaveBeenCalledWith({
      action: "use",
      entry: expect.objectContaining({ kind: "builtin" }),
    });

    const inherit = makePicker({ initialScope: "project" });
    inherit.component.handleInput("u");
    inherit.component.handleInput("\r");
    expect(inherit.close).toHaveBeenCalledWith({
      action: "use",
      entry: expect.objectContaining({ kind: "inherit-project" }),
    });
  });

  it("renders activation and deletion previews with confirmation-only controls", () => {
    const activation = makePicker();
    activation.component.handleInput("k");
    activation.component.handleInput("u");
    const activationOutput = activation.component.render(100).join("\n");
    expect(activationOutput).toContain("Confirm · Use [G] common?");
    expect(activationOutput).toContain("Reload  Required after activation");
    expect(activationOutput).toContain("Enter Confirm · Esc Cancel");

    const deletion = makePicker();
    deletion.component.handleInput("k");
    deletion.component.handleInput("x");
    const deletionOutput = deletion.component.render(100).join("\n");
    expect(deletionOutput).toContain("Confirm · Delete [G] common?");
    expect(deletionOutput).toContain("Enter Confirm · Esc Cancel");
  });

  it("distinguishes the active set from a saved selection pending reload", () => {
    const entries = profileSetPickerEntries(inspection("project"), true);
    const output = renderProfileSetPicker(
      {
        entries,
        selectedIndex: initialProfileSetPickerIndex(entries, "project"),
        query: "",
        searching: false,
        reloadRequired: true,
        sessionOverrideCount: 0,
        activeSelectionLabel: "[G] gold",
        savedSelectionLabel: "[P] project",
      },
      { theme: renderTheme, width: 100, height: 12 },
    ).join("\n");

    expect(output).toContain("Active now       [G] gold");
    expect(output).toContain("Saved selection  [P] project");
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
    expect(lines.join("\n")).toContain("Enter Edit · u Use");

    const compact = renderProfileSetPicker(
      {
        entries,
        selectedIndex: entries.length - 1,
        query: "",
        searching: false,
        reloadRequired: false,
        sessionOverrideCount: 0,
      },
      { theme: renderTheme, width: 24, height: 6 },
    );
    expect(compact).toHaveLength(6);
    expect(compact.every((line) => visibleWidth(line) <= 24)).toBe(true);

    for (const width of [0, 1, 2, 3, 4]) {
      const lines = renderProfileSetPicker(
        {
          entries,
          selectedIndex: entries.length - 1,
          query: "",
          searching: false,
          reloadRequired: false,
          sessionOverrideCount: 0,
        },
        { theme: renderTheme, width, height: 4 },
      );
      if (width === 0) expect(lines).toEqual([]);
      else {
        expect(lines).toHaveLength(4);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
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
