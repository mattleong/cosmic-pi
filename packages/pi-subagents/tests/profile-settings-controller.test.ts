import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type AutocompleteItem } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import type { SubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { SubagentConfigStoreError } from "../src/config/store.ts";
import {
  makeSessionProfileSnapshot,
  SessionProfileConflictError,
} from "../src/profiles/session-overrides.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import { ProfileWorkspaceComponent } from "../src/settings/profile-workspace.ts";
import { ProfileSetSaveFormComponent } from "../src/settings/profile-set-save-form.ts";
import type { ProfileSetPickerAction } from "../src/settings/profile-set-picker.ts";
import type {
  ProfileSettingsInspection,
  ProfileWorkspaceTarget,
} from "../src/settings/profile-route-editor.ts";
import { openProfileDashboard, type OpenProfileEditor } from "../src/settings/profile-dashboard.ts";
import type { ProfileWorkspaceCloseResult } from "../src/settings/profile-workspace.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, step } from "./support/effect-test.ts";

// SAFETY: The custom settings components use only the Theme methods implemented here.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

type OverlayResult =
  | ProfileSetPickerAction
  | ProfileWorkspaceCloseResult
  | ProfileWorkspaceTarget
  | undefined;
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
  return makeProfileSettingsInspection({
    globalDocument,
    projectDocument,
    projectTrusted: true,
  });
};

const invalidSourceInspection = (): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: "missing",
    profileSets: { valid: { profiles: {} } },
  };
  return makeProfileSettingsInspection({
    globalDocument,
    projectTrusted: false,
  });
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
  return makeProfileSettingsInspection({
    globalDocument,
    projectDocument,
    projectTrusted: true,
  });
};

const malformedGlobalDefaultInspection = (): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: [],
    profileSets: { common: { profiles: {} } },
  };
  return makeProfileSettingsInspection({
    globalDocument,
    projectTrusted: false,
  });
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
  captureModelRefresh: () => ({
    isCurrent: () => true,
    run: (effect, signal) => Effect.runPromise(effect, { signal }),
  }),
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
  inspectWriterWorkspace: vi.fn(() => Promise.resolve({ mode: "worktree" as const })),
  setWriterWorkspaceMode: vi.fn(() => Promise.resolve()),
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
  let completions: ((prefix: string) => AutocompleteItem[] | null) | undefined;
  let projectTrusted = options.trusted ?? true;
  const overlays: DisposableComponent[] = [];
  const pi = extensionApiFixture({
    registerCommand: vi.fn(
      (
        _name: string,
        definition: {
          handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
        },
      ) => {
        command = definition.handler;
        completions = definition.getArgumentCompletions;
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
    completions,
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
  if (!(fixture.overlays.at(-1) instanceof ProfileWorkspaceComponent)) {
    fixture.overlays.at(-1)?.handleInput?.("\u001b");
    yield* step(settleHostPromises);
  }
  fixture.overlays.at(-1)?.handleInput?.("\u001b");
  yield* step(() => running);
};

describe("profile settings controller", () => {
  effectTest("completes profile deep links and rejects unknown or extra arguments", function* () {
    const fixture = setup();
    expect(fixture.completions?.("profiles wor")?.map((item) => item.value)).toEqual([
      "profiles worker",
    ]);
    expect(fixture.completions?.("profiles ")?.map((item) => item.value)).toEqual(
      PROFILE_IDS.map((id) => `profiles ${id}`),
    );
    for (const args of ["profiles unknown", "profiles worker extra", "profiles WORKER"]) {
      yield* step(() => fixture.command?.(args, fixture.ctx) ?? Promise.resolve());
    }
    expect(fixture.overlays).toHaveLength(0);
    expect(fixture.managerActions.inspectProfiles).not.toHaveBeenCalled();
  });

  effectTest(
    "preserves editor position on cancel and resets only candidate on target changes",
    function* () {
      const fixture = setup();
      const open = vi
        .fn<OpenProfileEditor>()
        .mockResolvedValueOnce({
          action: "select-target",
          profile: "worker",
          field: "effort",
          candidateIndex: 2,
        })
        .mockResolvedValueOnce({
          action: "sets",
          profile: "worker",
          field: "effort",
          candidateIndex: 1,
        })
        .mockResolvedValueOnce({
          action: "select-target",
          profile: "worker",
          field: "effort",
          candidateIndex: 1,
        })
        .mockResolvedValueOnce(false);
      fixture.ui.custom
        .mockResolvedValueOnce({ kind: "profile-set", set: { scope: "global", name: "common" } })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ kind: "session" });
      yield* step(() => openProfileDashboard(fixture.ctx, fixture.managerActions, open, "worker"));
      expect(open.mock.calls[0]).toEqual([
        { kind: "session" },
        { initialProfile: "worker", initialFocus: "fields" },
      ]);
      expect(open.mock.calls[1]?.[0]).toEqual({
        kind: "profile-set",
        set: { scope: "global", name: "common" },
      });
      expect(open.mock.calls[1]?.[1]).toMatchObject({
        initialProfile: "worker",
        initialField: "effort",
        initialCandidateIndex: 0,
      });
      expect(open.mock.calls[2]?.[0]).toEqual(open.mock.calls[1]?.[0]);
      expect(open.mock.calls[2]?.[1]).toMatchObject({
        initialCandidateIndex: 1,
        initialField: "effort",
      });
      expect(open.mock.calls[3]).toEqual([
        { kind: "session" },
        {
          initialProfile: "worker",
          initialFocus: "fields",
          initialField: "effort",
          initialCandidateIndex: 0,
        },
      ]);
    },
  );

  for (const action of ["rename", "delete"] as const) {
    for (const editsActiveTarget of [true, false]) {
      effectTest(
        `${action} then cancel keeps a valid editor target (active: ${editsActiveTarget})`,
        function* () {
          const fixture = setup();
          const target = {
            kind: "profile-set" as const,
            set: { scope: "global" as const, name: "common" },
          };
          const open = vi
            .fn<OpenProfileEditor>()
            .mockResolvedValueOnce({ action: "select-target", profile: "worker" })
            .mockResolvedValueOnce({
              action: "sets",
              profile: "worker",
              field: "effort",
              candidateIndex: 2,
            })
            .mockResolvedValueOnce(false);
          fixture.ui.input.mockResolvedValueOnce("renamed");
          fixture.ui.custom
            .mockResolvedValueOnce(target)
            .mockResolvedValueOnce({
              action,
              target: editsActiveTarget ? target.set : { scope: "project", name: "common" },
            })
            .mockResolvedValueOnce(undefined);
          yield* step(() => openProfileDashboard(fixture.ctx, fixture.managerActions, open));
          expect(open.mock.calls[2]).toEqual([
            !editsActiveTarget
              ? target
              : action === "rename"
                ? { kind: "profile-set", set: { scope: "global", name: "renamed" } }
                : { kind: "session" },
            {
              initialProfile: "worker",
              initialField: "effort",
              initialFocus: "fields",
              initialCandidateIndex: editsActiveTarget ? 0 : 2,
            },
          ]);
          expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
        },
      );
    }
  }

  effectTest(
    "uses the displayed saved target and returns to Session after replacement",
    function* () {
      const fixture = setup();
      const open = vi
        .fn<OpenProfileEditor>()
        .mockResolvedValueOnce({ action: "select-target", profile: "scout" })
        .mockResolvedValueOnce({
          action: "use-current",
          profile: "scout",
          field: "model",
          candidateIndex: 1,
        })
        .mockResolvedValueOnce(false);
      fixture.ui.custom.mockResolvedValueOnce({
        kind: "profile-set",
        set: { scope: "global", name: "common" },
      });
      yield* step(() => openProfileDashboard(fixture.ctx, fixture.managerActions, open));
      expect(fixture.managerActions.replaceSessionProfiles).toHaveBeenCalledWith(
        expect.objectContaining({ origin: { scope: "global", name: "common" } }),
      );
      expect(open.mock.calls[2]?.[0]).toEqual({ kind: "session" });
      expect(open.mock.calls[2]?.[1]).toMatchObject({
        initialCandidateIndex: 0,
        initialProfile: "scout",
        initialField: "model",
      });
    },
  );

  effectTest(
    "does not open or refresh an editor after its inspection owner is replaced",
    function* () {
      const fixture = setup();
      const pending = Deferred.makeUnsafe<ProfileSettingsInspection>();
      let current = true;
      const submitted = vi.fn();
      const run = <A>(effect: Effect.Effect<A>, signal: AbortSignal) => {
        submitted();
        return Effect.runPromise(effect, { signal });
      };
      vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
        isCurrent: () => current,
        run,
      });
      vi.mocked(fixture.managerActions.inspectProfiles).mockImplementation(() =>
        Effect.runPromise(Deferred.await(pending)),
      );
      const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
      current = false;
      Deferred.doneUnsafe(pending, Effect.succeed(inspection()));
      yield* step(() => running);
      expect(fixture.overlays).toEqual([]);
      expect(submitted).not.toHaveBeenCalled();
    },
  );

  effectTest("always opens Current Session and rejects legacy scope arguments", function* () {
    const fixture = setup();
    const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
    expect(fixture.overlays[0]?.render(120).join("\n")).toContain("Current Session");
    fixture.overlays[0]?.handleInput?.("\u001b");
    yield* step(() => running);

    yield* step(() => fixture.command?.("profiles global", fixture.ctx) ?? Promise.resolve());
    expect(fixture.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /subagents [settings | profiles"),
      "error",
    );
  });

  effectTest("previews and atomically replaces all seven Current Session profiles", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("u");

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

      fixture.overlays[1]?.handleInput?.("u");

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
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() => expect(fixture.overlays.at(-1)).toBeInstanceOf(ProfileSetSaveFormComponent)),
    );
    for (const key of "session copy") fixture.overlays.at(-1)?.handleInput?.(key);
    fixture.overlays.at(-1)?.handleInput?.("\r");
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

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(4)));
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
    vi.mocked(fixture.managerActions.inspectProfiles)
      .mockResolvedValueOnce(displayed)
      .mockResolvedValueOnce(displayed)
      .mockResolvedValue(atSessionRevision(displayed, 1));
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() => expect(fixture.overlays.at(-1)).toBeInstanceOf(ProfileSetSaveFormComponent)),
    );
    for (const key of "stale copy") fixture.overlays.at(-1)?.handleInput?.(key);
    fixture.overlays.at(-1)?.handleInput?.("\r");
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

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(4)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest("rechecks Project trust after snapshot inspection settles", function* () {
    const displayed = inspection();
    const fixture = setup({ value: displayed });
    const pendingInspection = Deferred.makeUnsafe<ProfileSettingsInspection>();
    vi.mocked(fixture.managerActions.inspectProfiles)
      .mockResolvedValueOnce(displayed)
      .mockResolvedValueOnce(displayed)
      .mockImplementationOnce(() => Effect.runPromise(Deferred.await(pendingInspection)));
    const running = yield* openLibrary(fixture);

    fixture.overlays[1]?.handleInput?.("s");
    yield* step(() =>
      vi.waitFor(() => expect(fixture.overlays.at(-1)).toBeInstanceOf(ProfileSetSaveFormComponent)),
    );
    for (const key of "revoked copy") fixture.overlays.at(-1)?.handleInput?.(key);
    fixture.overlays.at(-1)?.handleInput?.("\r");
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

    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(4)));
    yield* closeLibraryAndDashboard(fixture, running);
  });

  effectTest(
    "makes a saved set default for new sessions without replacing Current Session",
    function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);

      fixture.overlays[1]?.handleInput?.("k");
      fixture.overlays[1]?.handleInput?.("?");
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
    fixture.overlays[1]?.handleInput?.("?");
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
      fixture.overlays[1]?.handleInput?.("?");
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
      fixture.overlays[1]?.handleInput?.("?");
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

      project.overlays[1]?.handleInput?.("?");
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
      global.overlays[1]?.handleInput?.("?");
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

    fixture.overlays[1]?.handleInput?.("?");
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

  effectTest("saves a writer workspace selection only through the coordinator", function* () {
    const fixture = setup();
    fixture.ui.select
      .mockResolvedValueOnce("Writer workspace")
      .mockResolvedValueOnce("Shared checkout");
    yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
    expect(fixture.managerActions.setWriterWorkspaceMode).toHaveBeenCalledWith("shared-checkout");
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  effectTest(
    "does not offer a workspace switch while the coordinator reports a blocker",
    function* () {
      const fixture = setup();
      vi.mocked(fixture.managerActions.inspectWriterWorkspace).mockResolvedValue({
        mode: "worktree",
        blockedReason: "Pending integration",
      });
      fixture.ui.select
        .mockResolvedValueOnce("Writer workspace")
        .mockResolvedValueOnce("Shared checkout");
      yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
      expect(fixture.managerActions.setWriterWorkspaceMode).not.toHaveBeenCalled();
      expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    },
  );

  effectTest(
    "keeps a rejected workspace switch unsuccessful and permits a later retry",
    function* () {
      const fixture = setup();
      vi.mocked(fixture.managerActions.setWriterWorkspaceMode).mockRejectedValueOnce(
        new Error("Writer reservation acquired"),
      );
      fixture.ui.select
        .mockResolvedValueOnce("Writer workspace")
        .mockResolvedValueOnce("Shared checkout");
      yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
      expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
      expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
      fixture.ui.select
        .mockResolvedValueOnce("Writer workspace")
        .mockResolvedValueOnce("Shared checkout");
      yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
      expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    },
  );

  effectTest("cancelling the workspace picker leaves the mode unchanged", function* () {
    const fixture = setup();
    fixture.ui.select.mockResolvedValueOnce("Writer workspace").mockResolvedValueOnce(undefined);
    yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
    expect(fixture.managerActions.setWriterWorkspaceMode).not.toHaveBeenCalled();
  });

  effectTest(
    "a workspace picker from a replaced session cannot change its successor",
    function* () {
      const fixture = setup();
      let current = true;
      vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
        isCurrent: () => current,
        run: (effect, signal) => Effect.runPromise(effect, { signal }),
      });
      fixture.ui.select.mockResolvedValueOnce("Writer workspace").mockImplementationOnce(() => {
        current = false;
        return Promise.resolve("Shared checkout");
      });
      yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
      expect(fixture.managerActions.setWriterWorkspaceMode).not.toHaveBeenCalled();
      expect(fixture.ui.notify).not.toHaveBeenCalled();
    },
  );

  for (const choice of ["Writer workspace", "Nesting limits"]) {
    for (const transition of ["replacement", "unavailable"]) {
      effectTest(`ignores an outer ${choice} selection after ${transition}`, function* () {
        const fixture = setup();
        const pending = Deferred.makeUnsafe<string>();
        let generation = 0;
        let available = true;
        vi.spyOn(fixture.managerActions, "isAvailable").mockImplementation(() => available);
        vi.spyOn(fixture.managerActions, "captureModelRefresh").mockImplementation(() => {
          const captured = generation;
          return {
            isCurrent: () => captured === generation,
            run: (effect, signal) => Effect.runPromise(effect, { signal }),
          };
        });
        fixture.ui.select.mockImplementationOnce(() => Effect.runPromise(Deferred.await(pending)));
        const running = fixture.command?.("settings", fixture.ctx) ?? Promise.resolve();
        expect(fixture.ui.select).toHaveBeenCalledTimes(1);
        if (transition === "replacement") generation += 1;
        else available = false;
        Deferred.doneUnsafe(pending, Effect.succeed(choice));
        yield* step(() => running);
        expect(fixture.ui.select).toHaveBeenCalledTimes(1);
        expect(fixture.ui.custom).not.toHaveBeenCalled();
        expect(fixture.managerActions.inspectWriterWorkspace).not.toHaveBeenCalled();
        expect(fixture.managerActions.inspectProfiles).not.toHaveBeenCalled();
        expect(fixture.managerActions.setWriterWorkspaceMode).not.toHaveBeenCalled();
        expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
        expect(fixture.managerActions.patchSessionNesting).not.toHaveBeenCalled();
      });
    }
  }

  for (const choice of ["Inherit limits", "Set limits"]) {
    effectTest(`rechecks Project trust after ${choice} prompts`, function* () {
      const fixture = setup();
      fixture.ui.select
        .mockResolvedValueOnce("Nesting limits")
        .mockResolvedValueOnce("Project")
        .mockImplementationOnce(() => {
          if (choice === "Inherit limits") fixture.setProjectTrusted(false);
          return Promise.resolve(choice);
        });
      fixture.ui.input.mockResolvedValueOnce("4").mockImplementationOnce(() => {
        fixture.setProjectTrusted(false);
        return Promise.resolve("2");
      });

      yield* step(() => fixture.command?.("settings", fixture.ctx) ?? Promise.resolve());
      expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
      expect(fixture.managerActions.patchSessionNesting).not.toHaveBeenCalled();
      expect(fixture.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("This project is no longer trusted"),
        "warning",
      );
    });
  }

  effectTest("keeps Current Session unchanged while editing a saved set", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);
    fixture.overlays[1]?.handleInput?.("\r");
    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
    expect(fixture.overlays[2]).toBeInstanceOf(ProfileWorkspaceComponent);
    expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
    fixture.overlays[2]?.handleInput?.("\u001b");
    yield* step(() => running);
  });

  for (const outcome of ["refresh", "refresh-failure", "other-error"] as const) {
    effectTest(`saved-set write handles ${outcome} without retrying the edit`, function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);
      fixture.overlays[1]?.handleInput?.("\r");
      yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(3)));
      const editor = fixture.overlays[2];
      const updated = makeProfileSettingsInspection({
        globalDocument: inspection().globalDocument,
        projectDocument: {
          version: 6,
          profileSets: { project: { profiles: {} }, external: { profiles: {} } },
        },
        projectTrusted: true,
      });
      const inspect = vi.mocked(fixture.managerActions.inspectProfiles);
      inspect.mockClear();
      if (outcome === "refresh-failure") inspect.mockRejectedValueOnce(new Error("read failed"));
      else inspect.mockResolvedValue(updated);
      vi.mocked(fixture.managerActions.patchProfile).mockRejectedValueOnce(
        new SubagentConfigStoreError({
          operation: "update",
          path: "/repo/.pi/subagents.json",
          message:
            outcome === "other-error"
              ? "permission denied"
              : "Subagents settings changed on disk; reopen /subagents profiles and try again.",
        }),
      );
      const changeEffort = function* () {
        editor?.handleInput?.("e");
        yield* step(settleHostPromises);
        editor?.handleInput?.("j");
        editor?.handleInput?.("\r");
      };
      yield* changeEffort();
      yield* step(settleHostPromises);
      expect(fixture.managerActions.patchProfile).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledTimes(outcome === "other-error" ? 0 : 1);
      yield* changeEffort();
      yield* step(settleHostPromises);
      if (outcome !== "refresh") {
        expect(fixture.managerActions.patchProfile).toHaveBeenCalledTimes(1);
      } else {
        expect(fixture.managerActions.patchProfile).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(fixture.managerActions.patchProfile).mock.calls[1]?.[0].expectedDocument,
        ).toEqual(updated.projectDocument);
      }
      editor?.handleInput?.("\u001b"); // Fields to profiles.
      editor?.handleInput?.("\u001b"); // Close the original workspace.
      yield* step(() => running);
    });
  }

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

    fixture.overlays[1]?.handleInput?.("u");
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
