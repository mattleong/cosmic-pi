import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import type { SubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import type { ProfileSetPickerAction } from "../src/settings/profile-set-picker.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import type { ProfileWorkspaceCloseResult } from "../src/settings/profile-workspace.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, step } from "./support/effect-test.ts";

// SAFETY: The pure test components use only these Theme methods.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

type ProfileOverlayResult = ProfileSetPickerAction | ProfileWorkspaceCloseResult | undefined;

type DisposableComponent = Component & { readonly dispose?: (() => void) | undefined };

const inspection = (withDefaults: boolean): ProfileSettingsInspection => {
  const globalDocument = withDefaults
    ? {
        version: 6,
        defaultProfileSet: "global",
        profileSets: { global: { profiles: {} } },
      }
    : { version: 6, profileSets: {} };
  const projectDocument = withDefaults
    ? {
        version: 6,
        defaultProfileSet: "project",
        profileSets: { project: { profiles: {} } },
      }
    : undefined;
  const global = decodeSubagentConfig(globalDocument, "global");
  const project = projectDocument ? decodeSubagentConfig(projectDocument, "project") : undefined;
  const configInput = {
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: project !== undefined,
    global,
  };
  const config = resolveSubagentConfig(project ? { ...configInput, project } : configInput);
  const baseInspection = {
    config,
    global,
    globalDocument,
    session: makeSessionProfileSnapshot(config),
  };
  if (!project || !projectDocument) return baseInspection;
  return { ...baseInspection, project, projectDocument };
};

const pendingSelectionInspection = (): ProfileSettingsInspection => {
  const saved = inspection(true);
  const activeProject = decodeSubagentConfig(
    { version: 6, profileSets: { project: { profiles: {} } } },
    "project",
  );
  const activeConfig = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: true,
    global: saved.global,
    project: activeProject,
  });
  return { ...saved, session: makeSessionProfileSnapshot(activeConfig) };
};

const actions = (value: ProfileSettingsInspection): FleetManagerActions => ({
  isAvailable: () => true,
  stop: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  send: () => Promise.resolve(),
  reply: () => Promise.resolve(),
  rename: () => Promise.resolve(),
  inspectProfiles: () => Promise.resolve(value),
  patchProfile: () => Promise.resolve(),
  patchDefaultProfileSet: vi.fn(() => Promise.resolve()),
  createProfileSet: () => Promise.resolve(),
  copyProfileSet: () => Promise.resolve(),
  renameProfileSet: () => Promise.resolve(),
  deleteProfileSet: () => Promise.resolve(),
  patchNesting: () => Promise.resolve(),
  patchSessionProfile: () => Promise.resolve(),
  patchSessionNesting: () => Promise.resolve(),
  clearSessionProfiles: () => Promise.resolve(),
  listNativeModels: () => Promise.resolve([]),
});

const setup = (value: ProfileSettingsInspection) => {
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const overlays: DisposableComponent[] = [];
  const pi = extensionApiFixture({
    registerCommand: vi.fn(
      (
        _name: string,
        definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        command = definition.handler;
      },
    ),
  });
  // SAFETY: Profile command tests never open the fleet manager, so no projection bridge member is read.
  const bridge = {} as SubagentProjectionBridge;
  const managerActions = actions(value);
  registerSubagentManagerCommand(pi, bridge, managerActions);
  const ui = {
    notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    input: vi.fn().mockResolvedValue(undefined),
    custom: vi.fn((factory: (...args: unknown[]) => DisposableComponent) => {
      const closed = Deferred.makeUnsafe<ProfileOverlayResult>();
      const component = factory(
        { terminal: { rows: 30 }, requestRender: vi.fn() },
        theme,
        {
          matches: (data: string, id: string) =>
            id === "tui.select.confirm"
              ? matchesKey(data, Key.enter)
              : id === "tui.select.cancel"
                ? matchesKey(data, Key.escape)
                : false,
          getKeys: () => [],
        },
        (result: ProfileOverlayResult) => Deferred.doneUnsafe(closed, Effect.succeed(result)),
      );
      overlays.push(component);
      return Effect.runPromise(Deferred.await(closed)).finally(() => component.dispose?.());
    }),
  };
  const ctx = extensionContextFixture({
    cwd: "/repo",
    signal: undefined,
    isProjectTrusted: () => true,
    hasUI: true,
    mode: "tui",
    ui,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });
  return { command, ctx, overlays, ui, managerActions };
};

describe("profile settings controller navigation", () => {
  effectTest("preserves a scope request made by an editor opened from Sets", function* () {
    const fixture = setup(inspection(true));
    expect(fixture.command).toBeDefined();
    const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
    expect(fixture.overlays[0]?.render(120).join("\n")).toContain("Current  1 Session");
    fixture.overlays[0]?.handleInput?.("s");

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(2)));
    fixture.overlays[1]?.handleInput?.("\r");

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    expect(fixture.overlays[2]?.render(120).join("\n")).toContain("Current  2 Project");
    fixture.overlays[2]?.handleInput?.("3");

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(4)));
    expect(fixture.overlays[3]?.render(120).join("\n")).toContain("Current  3 Global");
    fixture.overlays[3]?.handleInput?.("\u001b");
    yield* step(() => running);
  });

  effectTest("restores pending reload state from saved settings on a fresh command", function* () {
    const fixture = setup(pendingSelectionInspection());
    expect(fixture.command).toBeDefined();
    const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
    expect(fixture.overlays[0]?.render(120).join("\n")).toContain("reload required");
    fixture.overlays[0]?.handleInput?.("s");

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(2)));
    const sets = fixture.overlays[1]?.render(120).join("\n");
    expect(sets).toContain("Active now       [G] global");
    expect(sets).toContain("Saved selection  [P] project");
    fixture.overlays[1]?.handleInput?.("\u001b");

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    fixture.overlays[2]?.handleInput?.("\u001b");
    yield* step(() => running);
  });

  effectTest(
    "does not persist or require reload when the selected Project set is already active",
    function* () {
      const fixture = setup(inspection(true));
      expect(fixture.command).toBeDefined();
      const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
      fixture.overlays[0]?.handleInput?.("s");
      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(2)));
      fixture.overlays[1]?.handleInput?.("u");
      fixture.overlays[1]?.handleInput?.("\r");

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
      expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();
      expect(fixture.overlays[2]?.render(120).join("\n")).not.toContain("pending reload");
      fixture.overlays[2]?.handleInput?.("\u001b");

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(4)));
      fixture.overlays[3]?.handleInput?.("\u001b");
      yield* step(() => running);
    },
  );

  effectTest(
    "closes instead of opening Session when an unresolved initial scope is canceled",
    function* () {
      const fixture = setup(inspection(false));
      expect(fixture.command).toBeDefined();
      const running = fixture.command?.("profiles global", fixture.ctx) ?? Promise.resolve();

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
      expect(fixture.overlays[0]?.render(120).join("\n")).toContain("Profile sets");
      fixture.overlays[0]?.handleInput?.("\u001b");
      yield* step(() => running);

      expect(fixture.overlays).toHaveLength(1);
      expect(fixture.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Choose or create a Global default set"),
        "warning",
      );
    },
  );
});
