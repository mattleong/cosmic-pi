import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import type { SubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import {
  makeSessionProfileSnapshot,
  SessionProfileConflictError,
} from "../src/profiles/session-overrides.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import type { ProfileSetPickerAction } from "../src/settings/profile-set-picker.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import type { ProfileWorkspaceCloseResult } from "../src/settings/profile-workspace.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, step } from "./support/effect-test.ts";

// SAFETY: The custom settings components use only the Theme methods implemented here.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

type OverlayResult = ProfileSetPickerAction | ProfileWorkspaceCloseResult | undefined;
type DisposableComponent = Component & { readonly dispose?: (() => void) | undefined };

const inspection = (): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: "global",
    profileSets: {
      common: { profiles: {} },
      global: { profiles: {} },
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

const invalidSourceInspection = (): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: "missing",
    profileSets: { valid: { profiles: {} } },
  };
  const global = decodeSubagentConfig(globalDocument, "global");
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
    globalDocument,
    session: makeSessionProfileSnapshot(config),
  };
};

const invalidProjectInheritanceInspection = (): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: "missing",
    profileSets: {
      common: { profiles: {} },
      global: { profiles: {} },
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

const malformedGlobalDefaultInspection = (): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: [],
    profileSets: { common: { profiles: {} } },
  };
  const global = decodeSubagentConfig(globalDocument, "global");
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
    globalDocument,
    session: makeSessionProfileSnapshot(config),
  };
};

const atSessionRevision = (
  value: ProfileSettingsInspection,
  revision: number,
): ProfileSettingsInspection => ({
  ...value,
  session: makeSessionProfileSnapshot(value.config, { revision, overrides: {} }),
});

const actions = (value: ProfileSettingsInspection): FleetManagerActions => ({
  isAvailable: () => true,
  stop: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  send: () => Promise.resolve(),
  reply: () => Promise.resolve(),
  rename: () => Promise.resolve(),
  inspectProfiles: vi.fn(() => Promise.resolve(value)),
  patchProfile: vi.fn(() => Promise.resolve()),
  patchDefaultProfileSet: vi.fn(() => Promise.resolve()),
  createProfileSetFromSnapshot: vi.fn(() => Promise.resolve()),
  copyProfileSet: vi.fn(() => Promise.resolve()),
  renameProfileSet: vi.fn(() => Promise.resolve()),
  deleteProfileSet: vi.fn(() => Promise.resolve()),
  patchNesting: vi.fn(() => Promise.resolve()),
  patchSessionProfile: vi.fn(() => Promise.resolve()),
  replaceSessionProfiles: vi.fn(() => Promise.resolve()),
  patchSessionNesting: vi.fn(() => Promise.resolve()),
  listNativeModels: () => Promise.resolve([]),
});

const setup = (
  options: {
    readonly trusted?: boolean;
    readonly value?: ProfileSettingsInspection;
  } = {},
) => {
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let projectTrusted = options.trusted ?? true;
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
  // SAFETY: These command tests never open the fleet manager, so the bridge is never read.
  const bridge = {} as SubagentProjectionBridge;
  const managerActions = actions(options.value ?? inspection());
  registerSubagentManagerCommand(pi, bridge, managerActions);
  const ui = {
    notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    input: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(undefined),
    custom: vi.fn((factory: (...args: unknown[]) => DisposableComponent) => {
      const closed = Deferred.makeUnsafe<OverlayResult>();
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
        (result: OverlayResult) => Deferred.doneUnsafe(closed, Effect.succeed(result)),
      );
      overlays.push(component);
      return Effect.runPromise(Deferred.await(closed)).finally(() => component.dispose?.());
    }),
  };
  const ctx = extensionContextFixture({
    cwd: "/repo",
    signal: undefined,
    isProjectTrusted: () => projectTrusted,
    hasUI: true,
    mode: "tui",
    ui,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  });
  return {
    command,
    ctx,
    overlays,
    ui,
    managerActions,
    setProjectTrusted: (trusted: boolean) => {
      projectTrusted = trusted;
    },
  };
};

const openLibrary = function* (fixture: ReturnType<typeof setup>) {
  const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
  yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
  expect(fixture.overlays[0]?.render(120).join("\n")).toContain("Current Session");
  fixture.overlays[0]?.handleInput?.("p");
  yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(2)));
  return running;
};

const settleHostPromises = (): Promise<void> =>
  Array.from({ length: 12 }).reduce<Promise<void>>(
    (pending) => pending.then(() => undefined),
    Promise.resolve(),
  );

const closeLibraryAndDashboard = function* (
  fixture: ReturnType<typeof setup>,
  running: Promise<void>,
) {
  fixture.overlays.at(-1)?.handleInput?.("\u001b");
  yield* step(settleHostPromises);
  expect(fixture.overlays.at(-1)?.render(120).join("\n")).toContain("Current Session");
  fixture.overlays.at(-1)?.handleInput?.("\u001b");
  yield* step(() => running);
};

describe("profile settings controller", () => {
  effectTest("always opens Current Session and rejects legacy scope arguments", function* () {
    const fixture = setup();
    const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
    expect(fixture.overlays[0]?.render(120).join("\n")).toContain("Current Session");
    fixture.overlays[0]?.handleInput?.("\u001b");
    yield* step(() => running);

    yield* step(() => fixture.command?.("profiles global", fixture.ctx) ?? Promise.resolve());
    expect(fixture.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /subagents [settings | profiles]"),
      "error",
    );
  });

  effectTest("previews and atomically replaces all seven Current Session profiles", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("\r");
    fixture.overlays[1]?.handleInput?.("\r");

    yield* step(() =>
      vi.waitFor(() => expect(fixture.managerActions.replaceSessionProfiles).toHaveBeenCalled()),
    );
    expect(fixture.ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Use Project/project in Current Session"),
      expect.stringContaining(
        "Later changes to Current Session or the saved set will stay separate",
      ),
    );
    const patch = vi.mocked(fixture.managerActions.replaceSessionProfiles).mock.calls[0]?.[0];
    expect(patch?.expectedRevision).toBe(0);
    expect(Object.keys(patch?.profiles ?? {})).toEqual(PROFILE_IDS);
    expect(patch?.origin).toEqual({ scope: "project", name: "project" });

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest(
    "does not apply a Project set when trust is revoked during confirmation",
    function* () {
      const fixture = setup();
      fixture.ui.confirm.mockImplementationOnce(() => {
        fixture.setProjectTrusted(false);
        return Promise.resolve(true);
      });
      const running = yield* openLibrary(fixture);

      fixture.overlays[1]?.handleInput?.("\r");
      fixture.overlays[1]?.handleInput?.("\r");

      yield* step(() =>
        vi.waitFor(() =>
          expect(fixture.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining("This project is no longer trusted"),
            "warning",
          ),
        ),
      );
      expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
      yield* closeLibraryAndDashboard(fixture, running);
    },
  );

  effectTest("saves one seven-profile snapshot without changing the default", function* () {
    const fixture = setup();
    fixture.ui.select.mockResolvedValueOnce("Project");
    fixture.ui.input.mockResolvedValueOnce("session copy");
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() =>
        expect(fixture.managerActions.createProfileSetFromSnapshot).toHaveBeenCalled(),
      ),
    );
    const patch = vi.mocked(fixture.managerActions.createProfileSetFromSnapshot).mock.calls[0]?.[0];
    expect(patch?.scope).toBe("project");
    expect(patch?.profileSet).toBe("session copy");
    expect(patch?.expectedRevision).toBe(0);
    expect(patch).not.toHaveProperty("profiles");
    expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("blocks saving a session with invalid Project or Global profiles", function* () {
    const fixture = setup({ trusted: false, value: invalidSourceInspection() });
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() =>
        expect(fixture.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Fix or disable them in Current Session before saving"),
          "warning",
        ),
      ),
    );
    expect(fixture.ui.select).not.toHaveBeenCalled();
    expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("does not save when Current Session changes during the prompts", function* () {
    const displayed = inspection();
    const fixture = setup({ value: displayed });
    fixture.ui.select.mockResolvedValueOnce("Project");
    fixture.ui.input.mockResolvedValueOnce("stale copy");
    vi.mocked(fixture.managerActions.inspectProfiles)
      .mockResolvedValueOnce(displayed)
      .mockResolvedValueOnce(displayed)
      .mockResolvedValue(atSessionRevision(displayed, 1));
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() =>
        expect(fixture.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("changed while you were choosing where to save it"),
          "warning",
        ),
      ),
    );
    expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    expect(fixture.managerActions.inspectProfiles).toHaveBeenCalledTimes(3);

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("rechecks Project trust after snapshot inspection settles", function* () {
    const displayed = inspection();
    const fixture = setup({ value: displayed });
    fixture.ui.select.mockResolvedValueOnce("Project");
    fixture.ui.input.mockResolvedValueOnce("revoked copy");
    const pendingInspection = Deferred.makeUnsafe<ProfileSettingsInspection>();
    vi.mocked(fixture.managerActions.inspectProfiles)
      .mockResolvedValueOnce(displayed)
      .mockResolvedValueOnce(displayed)
      .mockImplementationOnce(() => Effect.runPromise(Deferred.await(pendingInspection)));
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() => expect(fixture.managerActions.inspectProfiles).toHaveBeenCalledTimes(3)),
    );
    fixture.setProjectTrusted(false);
    Deferred.doneUnsafe(pendingInspection, Effect.succeed(displayed));
    yield* step(() =>
      vi.waitFor(() =>
        expect(fixture.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("This project is no longer trusted"),
          "warning",
        ),
      ),
    );
    expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest(
    "makes a saved set default for new sessions without replacing Current Session",
    function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);

      fixture.overlays[1]?.handleInput?.("k");
      fixture.overlays[1]?.handleInput?.("\r");
      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("\r");

      yield* step(() =>
        vi.waitFor(() => expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalled()),
      );
      expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "project",
          defaultProfileSet: "common",
        }),
      );
      expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
      expect(fixture.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("new sessions. Current Session did not change"),
        "info",
      );

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
      yield* closeLibraryAndDashboard(fixture, running);
    },
  );

  effectTest("rechecks Project trust after default inspection settles", function* () {
    const initial = inspection();
    const fixture = setup({ value: initial });
    const pendingInspection = Deferred.makeUnsafe<ProfileSettingsInspection>();
    vi.mocked(fixture.managerActions.inspectProfiles)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => Effect.runPromise(Deferred.await(pendingInspection)));
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("k");
    fixture.overlays[1]?.handleInput?.("\r");
    fixture.overlays[1]?.handleInput?.("j");
    fixture.overlays[1]?.handleInput?.("j");
    fixture.overlays[1]?.handleInput?.("\r");
    yield* step(() =>
      vi.waitFor(() => expect(fixture.managerActions.inspectProfiles).toHaveBeenCalledTimes(3)),
    );
    fixture.setProjectTrusted(false);
    Deferred.doneUnsafe(pendingInspection, Effect.succeed(initial));

    yield* step(() =>
      vi.waitFor(() =>
        expect(fixture.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("This project is no longer trusted"),
          "warning",
        ),
      ),
    );
    expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest(
    "blocks a refreshed Project default that inherits invalid Global routes",
    function* () {
      const initial = inspection();
      const invalid = invalidProjectInheritanceInspection();
      const fixture = setup({ value: initial });
      vi.mocked(fixture.managerActions.inspectProfiles)
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(invalid);
      const running = yield* openLibrary(fixture);

      fixture.overlays[1]?.handleInput?.("k");
      fixture.overlays[1]?.handleInput?.("\r");
      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("\r");

      yield* step(() =>
        vi.waitFor(() =>
          expect(fixture.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining("saved set is invalid"),
            "warning",
          ),
        ),
      );
      expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
      yield* closeLibraryAndDashboard(fixture, running);
    },
  );

  effectTest(
    "warns when the Project default takes priority over a new Global default",
    function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);

      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("\r");
      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("j");
      fixture.overlays[1]?.handleInput?.("\r");

      yield* step(() =>
        vi.waitFor(() => expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalled()),
      );
      expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global", defaultProfileSet: "common" }),
      );
      expect(fixture.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("This project's default still takes priority"),
        "info",
      );

      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
      yield* closeLibraryAndDashboard(fixture, running);
    },
  );

  effectTest(
    "clears Project and Global defaults without changing or deleting saved sets",
    function* () {
      const project = setup();
      const projectRunning = yield* openLibrary(project);

      project.overlays[1]?.handleInput?.("\r");
      project.overlays[1]?.handleInput?.("j");
      project.overlays[1]?.handleInput?.("j");
      project.overlays[1]?.handleInput?.("\r");
      yield* step(() =>
        vi.waitFor(() => expect(project.managerActions.patchDefaultProfileSet).toHaveBeenCalled()),
      );
      const projectPatch = vi.mocked(project.managerActions.patchDefaultProfileSet).mock
        .calls[0]?.[0];
      expect(projectPatch).toMatchObject({ scope: "project" });
      expect(projectPatch).not.toHaveProperty("defaultProfileSet");
      expect(project.managerActions.deleteProfileSet).not.toHaveBeenCalled();
      expect(project.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
      expect(project.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "New sessions in this project will use Global, then built-in profiles",
        ),
        "info",
      );
      expect(project.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Project/project is still saved"),
        "info",
      );
      yield* step(() => vi.waitFor(() => expect(project.overlays).toHaveLength(3)));
      yield* closeLibraryAndDashboard(project, projectRunning);

      const global = setup();
      const globalRunning = yield* openLibrary(global);
      global.overlays[1]?.handleInput?.("j");
      global.overlays[1]?.handleInput?.("j");
      global.overlays[1]?.handleInput?.("\r");
      global.overlays[1]?.handleInput?.("j");
      global.overlays[1]?.handleInput?.("j");
      global.overlays[1]?.handleInput?.("\r");
      yield* step(() =>
        vi.waitFor(() => expect(global.managerActions.patchDefaultProfileSet).toHaveBeenCalled()),
      );
      const globalPatch = vi.mocked(global.managerActions.patchDefaultProfileSet).mock
        .calls[0]?.[0];
      expect(globalPatch).toMatchObject({ scope: "global" });
      expect(globalPatch).not.toHaveProperty("defaultProfileSet");
      expect(global.managerActions.deleteProfileSet).not.toHaveBeenCalled();
      expect(global.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
      expect(global.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "New sessions without a Project default will use built-in profiles",
        ),
        "info",
      );
      yield* step(() => vi.waitFor(() => expect(global.overlays).toHaveLength(3)));
      yield* closeLibraryAndDashboard(global, globalRunning);
    },
  );

  effectTest("clears a malformed default by scope without naming a saved set", function* () {
    const fixture = setup({ trusted: false, value: malformedGlobalDefaultInspection() });
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("\r");
    fixture.overlays[1]?.handleInput?.("\r");
    yield* step(() =>
      vi.waitFor(() => expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalled()),
    );
    expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "global" }),
    );
    const notices = fixture.ui.notify.mock.calls.map(([message]) => String(message));
    expect(notices.some((message) => message.includes("will no longer use a saved set"))).toBe(
      true,
    );
    expect(notices.some((message) => message.includes("is still saved"))).toBe(false);

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("rechecks Project trust after nesting prompts", function* () {
    const fixture = setup();
    fixture.ui.select.mockResolvedValueOnce("Project").mockImplementationOnce(() => {
      fixture.setProjectTrusted(false);
      return Promise.resolve("Inherit limits");
    });

    yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
    expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("This project is no longer trusted"),
      "warning",
    );
  });

  effectTest("keeps Current Session unchanged while editing a saved set", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("\r");
    fixture.overlays[1]?.handleInput?.("j");
    fixture.overlays[1]?.handleInput?.("\r");
    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    expect(fixture.overlays[2]?.render(120).join("\n")).toContain(
      "Saved set · Project/project · Current Session unchanged",
    );
    fixture.overlays[2]?.handleInput?.("\u001b");
    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(4)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("rejects a stale Current Session update without retrying", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.replaceSessionProfiles).mockRejectedValueOnce(
      new SessionProfileConflictError({
        expectedRevision: 0,
        actualRevision: 1,
        message: "conflict",
      }),
    );
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("\r");
    fixture.overlays[1]?.handleInput?.("\r");
    yield* step(() =>
      vi.waitFor(() =>
        expect(fixture.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Nothing was replaced"),
          "warning",
        ),
      ),
    );
    expect(fixture.managerActions.replaceSessionProfiles).toHaveBeenCalledTimes(1);
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Copied Project/project into Current Session"),
      "info",
    );

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("keeps Project saved sets unavailable when the project is untrusted", function* () {
    const fixture = setup({ trusted: false });
    const running = yield* openLibrary(fixture);
    const text = fixture.overlays[1]?.render(120).join("\n");
    expect(text).toContain("Project sets unavailable");
    expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();
    yield* closeLibraryAndDashboard(fixture, running);
  });
});
