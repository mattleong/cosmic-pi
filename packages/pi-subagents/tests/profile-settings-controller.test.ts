import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { describe, expect, vi } from "vitest";
import { extensionContextFixture, opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import {
  fleetManagerActionsFixture,
  makeProfileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { SubagentConfigStoreError } from "../src/config/store.ts";
import {
  makeSessionProfileSnapshot,
  SessionProfileConflictError,
} from "../src/profiles/session-overrides.ts";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import { ProfileDashboardComponent } from "../src/settings/profile-dashboard-component.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import {
  SubagentFleetComponent,
  type FleetMessageDelivery,
  type FleetNoticeKind,
} from "../src/ui/fleet.ts";
import { extensionApiFixture, mountingCustomUi } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";
import { effectTest, step } from "./support/effect-test.ts";

type DisposableComponent = Component & { readonly dispose?: (() => void) | undefined };

const inspection = (globalDefault = "global"): ProfileSettingsInspection => {
  const globalDocument = {
    version: 6,
    defaultProfileSet: globalDefault,
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

const actions = (value: ProfileSettingsInspection) =>
  fleetManagerActionsFixture({
    inspectProfiles: vi.fn(() => Promise.resolve(value)),
    patchProfile: vi.fn(() => Promise.resolve(value.projectDocument ?? {})),
    restoreProfileDeclaration: vi.fn(() => Promise.resolve(value.projectDocument ?? {})),
    patchDefaultProfileSet: vi.fn(() => Promise.resolve()),
    createProfileSetFromSnapshot: vi.fn(() => Promise.resolve()),
    copyProfileSet: vi.fn(() => Promise.resolve()),
    renameProfileSet: vi.fn(() => Promise.resolve()),
    deleteProfileSet: vi.fn(() => Promise.resolve()),
    patchNesting: vi.fn(() => Promise.resolve()),
    patchFeatureToggle: vi.fn(() => Promise.resolve()),
    inspectWriterWorkspace: vi.fn(() =>
      Promise.resolve({ mode: "worktree" as const, canSwitch: true }),
    ),
    setWriterWorkspaceMode: vi.fn(() => Promise.resolve()),
    patchSessionProfile: vi.fn(() => Promise.resolve(value.session)),
    replaceSessionProfiles: vi.fn(() => Promise.resolve(value.session)),
    patchSessionNesting: vi.fn(() => Promise.resolve()),
    listNativeModels: () => Promise.resolve([]),
  });

const setup = (
  options: {
    readonly trusted?: boolean;
    readonly value?: ProfileSettingsInspection;
  } = {},
) => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  let completions: ((prefix: string) => AutocompleteItem[] | null) | undefined;
  let projectTrusted = options.trusted ?? true;
  const overlays: DisposableComponent[] = [];
  const { custom } = mountingCustomUi(plainTheme, (component) => overlays.push(component), {
    columns: 120,
    rows: 30,
  });
  const pi = extensionApiFixture({
    registerCommand: vi.fn(
      (
        name: string,
        definition: {
          handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
        },
      ) => {
        handlers.set(name, definition.handler);
        if (name === "subagents") completions = definition.getArgumentCompletions;
      },
    ),
  });
  const managerActions = actions(options.value ?? inspection());
  // These command tests never open the fleet manager, so the bridge is never read.
  registerSubagentManagerCommand(pi, opaqueFixture({}), managerActions);
  const ui = {
    notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    input: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue(undefined),
    custom: vi.fn(custom),
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
    command: handlers.get("subagents"),
    settings: (args: string) =>
      handlers.get("subagents")?.(`settings ${args}`, ctx) ?? Promise.resolve(),
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

const settleHostPromises = (): Promise<void> =>
  Array.from({ length: 40 }).reduce<Promise<void>>(
    (pending) => pending.then(() => undefined),
    Promise.resolve(),
  );
const press = (fixture: ReturnType<typeof setup>, ...keys: string[]) => {
  for (const key of keys) {
    fixture.overlays[0]?.handleInput?.(key);
    fixture.overlays[0]?.render(120);
  }
};
const openDashboard = function* (fixture: ReturnType<typeof setup>, args = "profiles") {
  const running = fixture.command?.(args, fixture.ctx) ?? Promise.resolve();
  yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
  expect(fixture.overlays[0]).toBeInstanceOf(ProfileDashboardComponent);
  return running;
};
const openLibrary = function* (fixture: ReturnType<typeof setup>) {
  const running = yield* openDashboard(fixture);
  press(fixture, "\t");
  return running;
};
const closeDashboard = function* (fixture: ReturnType<typeof setup>, running: Promise<void>) {
  yield* step(settleHostPromises);
  press(fixture, "\u001b", "\u001b", "\u001b", "\u001b");
  yield* step(() => running);
  expect(fixture.ui.custom).toHaveBeenCalledTimes(1);
};
const saveSnapshot = function* (fixture: ReturnType<typeof setup>, name = "snapshot") {
  press(fixture, "s");
  yield* step(settleHostPromises);
  press(fixture, ...name, "\r");
  yield* step(settleHostPromises);
};
const useSelectedSet = function* (fixture: ReturnType<typeof setup>, beforeConfirm?: () => void) {
  press(fixture, "u");
  yield* step(settleHostPromises);
  fixture.overlays[0]?.render(120);
  beforeConfirm?.();
  press(fixture, "\r");
  yield* step(settleHostPromises);
};
const makeDefault = (fixture: ReturnType<typeof setup>) => press(fixture, "k", "?", "\r");

describe("profile settings controller", () => {
  effectTest("completes profile deep links and rejects unknown or extra arguments", function* () {
    const fixture = setup();
    expect(fixture.completions?.("profiles wor")?.map((item) => item.value)).toEqual([
      "profiles worker",
    ]);
    expect(fixture.completions?.("profiles ")?.map((item) => item.value)).toEqual(
      PROFILE_IDS.map((id) => `profiles ${id}`),
    );
    for (const args of [
      "profiles unknown",
      "profiles worker extra",
      "profiles WORKER",
      "profiles global",
    ])
      yield* step(() => fixture.command?.(args, fixture.ctx) ?? Promise.resolve());
    expect(fixture.overlays).toHaveLength(0);
    expect(fixture.managerActions.inspectProfiles).not.toHaveBeenCalled();
  });

  for (const mode of ["rpc", "json"] as const) {
    effectTest(`rejects profile settings outside the TUI (${mode})`, function* () {
      const fixture = setup();
      yield* step(
        () =>
          fixture.command?.("profiles worker", { ...fixture.ctx, mode, hasUI: false }) ??
          Promise.resolve(),
      );
      expect(fixture.ui.custom).not.toHaveBeenCalled();
      expect(fixture.managerActions.inspectProfiles).not.toHaveBeenCalled();
    });
  }

  effectTest(
    "activation shutdown closes an open dashboard dialog without further input",
    function* () {
      const fixture = setup();
      const activation = new AbortController();
      vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
        isCurrent: () => !activation.signal.aborted,
        run: (effect, signal) =>
          Effect.runPromise(effect, {
            signal: AbortSignal.any([signal, activation.signal]),
          }),
      });
      const running = yield* openDashboard(fixture);
      press(fixture, "s");
      yield* step(settleHostPromises);
      activation.abort();
      yield* step(() => running);
      expect(fixture.overlays[0]?.render(80)).toEqual([]);
      expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    },
  );

  effectTest(
    "activation shutdown before mount waits to close without popping a stacked overlay",
    function* () {
      const fixture = setup();
      const host = fakeCustomSurfaceHost({ theme: plainTheme, columns: 120, rows: 30 });
      fixture.ui.custom.mockImplementation(host.ctx.ui.custom);
      const activation = new AbortController();
      vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
        isCurrent: () => !activation.signal.aborted,
        run: (effect, signal) =>
          Effect.runPromise(effect, {
            signal: AbortSignal.any([signal, activation.signal]),
          }),
      });
      const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
      yield* step(() => vi.waitFor(() => expect(fixture.ui.custom).toHaveBeenCalledOnce()));
      const questionnaire = { render: () => ["questionnaire"], invalidate() {} };
      host.showUnrelated(questionnaire);
      activation.abort();
      yield* step(settleHostPromises);
      expect(host.doneCalls).toBe(0);
      host.mount();
      yield* step(() => running);
      expect(host.overlays).toEqual([questionnaire]);
      expect(host.doneCalls).toBe(1);
    },
  );

  effectTest("opens the first profile by default", function* () {
    const fixture = setup();
    const running = yield* openDashboard(fixture);
    press(fixture, "e", "j", "\r");
    yield* step(settleHostPromises);
    expect(fixture.managerActions.patchSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profile: PROFILE_IDS[0] }),
    );
    yield* closeDashboard(fixture, running);
  });

  effectTest("deep links edit the requested Session profile, not a saved default", function* () {
    const fixture = setup();
    const running = yield* openDashboard(fixture, "profiles worker");
    press(fixture, "e");
    yield* step(settleHostPromises);
    press(fixture, "j", "\r");
    yield* step(settleHostPromises);
    expect(fixture.managerActions.patchSessionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "worker" }),
    );
    expect(fixture.managerActions.patchProfile).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  effectTest("does not open or refresh after its inspection owner is replaced", function* () {
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
  });

  effectTest("disposal aborts the dashboard model refresh and is idempotent", function* () {
    const fixture = setup();
    let signal: AbortSignal | undefined;
    vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
      isCurrent: () => true,
      run: <A>(_effect: Effect.Effect<A>, captured: AbortSignal) => {
        signal = captured;
        return Effect.runPromise(Effect.never, { signal: captured });
      },
    });
    const running = yield* openDashboard(fixture);
    expect(signal?.aborted).toBe(false);
    yield* closeDashboard(fixture, running);
    expect(signal?.aborted).toBe(true);
    fixture.overlays[0]?.dispose?.();
    expect(fixture.managerActions.patchSessionProfile).not.toHaveBeenCalled();
  });

  effectTest(
    "previews and atomically replaces all seven Session profiles in one host slot",
    function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);
      yield* useSelectedSet(fixture, () =>
        expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled(),
      );
      const patch = vi.mocked(fixture.managerActions.replaceSessionProfiles).mock.calls[0]?.[0];
      expect(patch?.expectedRevision).toBe(0);
      expect(Object.keys(patch?.profiles ?? {})).toEqual(PROFILE_IDS);
      expect(patch?.origin).toEqual({ scope: "project", name: "project" });
      expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();
      yield* closeDashboard(fixture, running);
    },
  );

  effectTest("cancelled replacement leaves Session unchanged", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);
    press(fixture, "u");
    yield* step(settleHostPromises);
    press(fixture, "\u001b");
    yield* step(settleHostPromises);
    expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  effectTest("rejects a stale Session replacement without retrying", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.replaceSessionProfiles).mockRejectedValueOnce(
      new SessionProfileConflictError({
        expectedRevision: 0,
        actualRevision: 1,
        message: "conflict",
      }),
    );
    const running = yield* openLibrary(fixture);
    yield* useSelectedSet(fixture);
    expect(fixture.managerActions.replaceSessionProfiles).toHaveBeenCalledTimes(1);
    yield* closeDashboard(fixture, running);
  });

  effectTest("saves one seven-profile snapshot without changing defaults", function* () {
    const fixture = setup();
    const running = yield* openDashboard(fixture);
    yield* saveSnapshot(fixture);
    expect(fixture.managerActions.createProfileSetFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", profileSet: "snapshot", expectedRevision: 0 }),
    );
    const patch = vi.mocked(fixture.managerActions.createProfileSetFromSnapshot).mock.calls[0]?.[0];
    expect(patch).not.toHaveProperty("profiles");
    expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  for (const [label, value] of [
    ["invalid source", invalidSourceInspection],
    ["invalid Project inheritance", () => inspection("missing")],
  ] as const) {
    effectTest(`blocks snapshots with invalid inherited routes (${label})`, function* () {
      const fixture = setup({ value: value() });
      const running = yield* openDashboard(fixture);
      yield* saveSnapshot(fixture);
      expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
      yield* closeDashboard(fixture, running);
    });
  }

  effectTest("Saved profiles cannot save a Session snapshot", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);
    yield* saveSnapshot(fixture);
    expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  effectTest("invalid inherited saved routes cannot replace Session", function* () {
    const fixture = setup({ value: inspection("missing") });
    const running = yield* openLibrary(fixture);
    yield* useSelectedSet(fixture);
    expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  effectTest("does not save when Session changes during the form", function* () {
    const displayed = inspection();
    const fixture = setup({ value: displayed });
    const running = yield* openDashboard(fixture);
    vi.mocked(fixture.managerActions.inspectProfiles).mockResolvedValue(
      atSessionRevision(displayed, 1),
    );
    yield* saveSnapshot(fixture);
    expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  for (const action of ["snapshot", "default"] as const) {
    effectTest(`rechecks Project trust after ${action} inspection settles`, function* () {
      const fixture = setup();
      const running =
        action === "snapshot" ? yield* openDashboard(fixture) : yield* openLibrary(fixture);
      const pending = Deferred.makeUnsafe<ProfileSettingsInspection>();
      const inspect = vi.mocked(fixture.managerActions.inspectProfiles);
      inspect.mockClear();
      inspect.mockImplementationOnce(() => Effect.runPromise(Deferred.await(pending)));
      if (action === "snapshot") yield* saveSnapshot(fixture);
      else makeDefault(fixture);
      yield* step(settleHostPromises);
      expect(inspect).toHaveBeenCalledTimes(1);
      fixture.setProjectTrusted(false);
      Deferred.doneUnsafe(pending, Effect.succeed(inspection()));
      yield* step(settleHostPromises);
      expect(fixture.managerActions.createProfileSetFromSnapshot).not.toHaveBeenCalled();
      expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();
      yield* closeDashboard(fixture, running);
    });
  }

  effectTest("makes a saved set default without replacing Session", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);
    makeDefault(fixture);
    yield* step(settleHostPromises);
    expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", defaultProfileSet: "common" }),
    );
    expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  effectTest("blocks a refreshed default that inherits invalid Global routes", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);
    vi.mocked(fixture.managerActions.inspectProfiles).mockResolvedValue(inspection("missing"));
    makeDefault(fixture);
    yield* step(settleHostPromises);
    expect(fixture.managerActions.patchDefaultProfileSet).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  effectTest(
    "writes only Global when making a Global set default under a Project default",
    function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);
      press(fixture, "j", "?", "\r");
      yield* step(settleHostPromises);
      expect(fixture.managerActions.patchDefaultProfileSet).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global", defaultProfileSet: "common" }),
      );
      expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
      yield* closeDashboard(fixture, running);
    },
  );

  for (const scope of ["project", "global"] as const) {
    effectTest(`clears ${scope} default without changing saved sets or Session`, function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);
      if (scope === "global") press(fixture, "j", "j");
      press(fixture, "?", "\r");
      yield* step(settleHostPromises);
      const patch = vi.mocked(fixture.managerActions.patchDefaultProfileSet).mock.calls[0]?.[0];
      expect(patch).toMatchObject({ scope });
      expect(patch).not.toHaveProperty("defaultProfileSet");
      expect(fixture.managerActions.deleteProfileSet).not.toHaveBeenCalled();
      expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
      yield* closeDashboard(fixture, running);
    });
  }

  effectTest("clears a malformed default by scope without naming a saved set", function* () {
    const fixture = setup({ trusted: false, value: malformedGlobalDefaultInspection() });
    const running = yield* openLibrary(fixture);
    press(fixture, "?", "\r");
    yield* step(settleHostPromises);
    const patch = vi.mocked(fixture.managerActions.patchDefaultProfileSet).mock.calls[0]?.[0];
    expect(patch).toMatchObject({ scope: "global" });
    expect(patch).not.toHaveProperty("defaultProfileSet");
    yield* closeDashboard(fixture, running);
  });

  effectTest("keeps Session unchanged while editing a saved set", function* () {
    const fixture = setup();
    const running = yield* openLibrary(fixture);
    press(fixture, "\r", "e");
    yield* step(settleHostPromises);
    press(fixture, "j", "\r");
    yield* step(settleHostPromises);
    expect(fixture.managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", profileSet: "project" }),
    );
    expect(fixture.managerActions.patchSessionProfile).not.toHaveBeenCalled();
    expect(fixture.managerActions.replaceSessionProfiles).not.toHaveBeenCalled();
    yield* closeDashboard(fixture, running);
  });

  for (const outcome of ["refresh", "refresh-failure", "other-error"] as const) {
    effectTest(`saved-set write handles ${outcome} without retrying the edit`, function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);
      press(fixture, "\r");
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
        press(fixture, "e");
        yield* step(settleHostPromises);
        press(fixture, "j", "\r");
        yield* step(settleHostPromises);
      };
      yield* changeEffort();
      expect(fixture.managerActions.patchProfile).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledTimes(outcome === "other-error" ? 0 : 1);
      yield* changeEffort();
      if (outcome !== "refresh")
        expect(fixture.managerActions.patchProfile).toHaveBeenCalledTimes(1);
      else {
        expect(fixture.managerActions.patchProfile).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(fixture.managerActions.patchProfile).mock.calls[1]?.[0].expectedDocument,
        ).toEqual(updated.projectDocument);
      }
      yield* closeDashboard(fixture, running);
    });
  }

  effectTest("does not offer Project saved sets to untrusted projects", function* () {
    const fixture = setup({ trusted: false });
    const running = yield* openLibrary(fixture);
    yield* useSelectedSet(fixture);
    const patch = vi.mocked(fixture.managerActions.replaceSessionProfiles).mock.calls[0]?.[0];
    expect(patch?.origin.scope).toBe("global");
    yield* closeDashboard(fixture, running);
  });

  effectTest("does not switch the workspace while the coordinator reports a blocker", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.inspectWriterWorkspace).mockResolvedValue({
      mode: "worktree",
      canSwitch: false,
      blockedReason: "Unresolved workspace ws-1 remains at /private/tmp/ws-1.",
      blockedCode: "unresolved-workspace",
    });
    yield* step(() => fixture.settings("writerWorkspace shared-checkout"));
    expect(fixture.managerActions.setWriterWorkspaceMode).not.toHaveBeenCalled();
    const [message] = fixture.ui.notify.mock.calls.at(-1) ?? [];
    expect(message).not.toMatch(/ws-1|\/private/u);
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });

  effectTest(
    "keeps a rejected workspace switch unsuccessful and permits a later retry",
    function* () {
      const fixture = setup();
      vi.mocked(fixture.managerActions.setWriterWorkspaceMode).mockRejectedValueOnce(
        new Error("Writer reservation acquired"),
      );
      yield* step(() => fixture.settings("writerWorkspace shared-checkout"));
      expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
      expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
      yield* step(() => fixture.settings("writerWorkspace shared-checkout"));
      expect(fixture.managerActions.setWriterWorkspaceMode).toHaveBeenLastCalledWith(
        "shared-checkout",
      );
      expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    },
  );

  effectTest("a change from a replaced session cannot change its successor", function* () {
    const fixture = setup();
    let current = true;
    vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
      isCurrent: () => current,
      run: (effect, signal) => Effect.runPromise(effect, { signal }),
    });
    vi.mocked(fixture.managerActions.inspectWriterWorkspace).mockImplementationOnce(() => {
      current = false;
      return Promise.resolve({ mode: "worktree", canSwitch: true });
    });
    yield* step(() => fixture.settings("writerWorkspace shared-checkout"));
    expect(fixture.managerActions.setWriterWorkspaceMode).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalled();
  });

  effectTest("changes nothing while subagents are unavailable", function* () {
    const fixture = setup();
    vi.spyOn(fixture.managerActions, "isAvailable").mockReturnValue(false);
    for (const args of ["writerWorkspace shared-checkout", "global maxDepth 2", ""])
      yield* step(() => fixture.settings(args));
    expect(fixture.managerActions.inspectWriterWorkspace).not.toHaveBeenCalled();
    expect(fixture.managerActions.inspectProfiles).not.toHaveBeenCalled();
    expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
  });

  effectTest(
    "saves one nesting limit to the named scope and clears a scope with inherit",
    function* () {
      const fixture = setup();
      yield* step(() => fixture.settings("global maxDepth 2"));
      expect(vi.mocked(fixture.managerActions.patchNesting).mock.calls[0]?.[0]).toMatchObject({
        scope: "global",
        nesting: { maxDepth: 2 },
      });
      yield* step(() => fixture.settings("maxDirectChildren inherit"));
      const sessionPatch = vi.mocked(fixture.managerActions.patchSessionNesting).mock.calls[0]?.[0];
      expect(sessionPatch).toBeDefined();
      expect(sessionPatch).not.toHaveProperty("nesting");
      yield* step(() => fixture.settings("maxDepth 99"));
      expect(fixture.ui.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
    },
  );

  effectTest("rechecks Project trust before a Project nesting write", function* () {
    const fixture = setup();
    const inspect = fixture.managerActions.inspectProfiles;
    vi.mocked(fixture.managerActions.inspectProfiles).mockImplementationOnce((trusted) => {
      fixture.setProjectTrusted(false);
      return vi.mocked(inspect).getMockImplementation()!(trusted);
    });
    yield* step(() => fixture.settings("project maxDepth 2"));
    expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/trust/iu), "error");
  });
});

describe("feature switch settings", () => {
  const featurePatches = (fixture: ReturnType<typeof setup>) =>
    vi.mocked(fixture.managerActions.patchFeatureToggle).mock.calls.map(([patch]) => patch);

  effectTest("saves each switch to the named scope against its inspected document", function* () {
    const fixture = setup();
    const value = inspection();
    yield* step(() => fixture.settings("global scriptedWorkflows false"));
    yield* step(() => fixture.settings("project automaticProfileRouting true"));
    expect(featurePatches(fixture)).toEqual([
      {
        scope: "global",
        toggle: "scriptedWorkflows",
        enabled: false,
        expectedExists: true,
        expectedDocument: value.globalDocument,
        projectTrusted: true,
      },
      {
        scope: "project",
        toggle: "automaticProfileRouting",
        enabled: true,
        expectedExists: true,
        expectedDocument: value.projectDocument,
        projectTrusted: true,
      },
    ]);
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "error");
  });

  effectTest("inherit removes the scope's own value, even with no file yet", function* () {
    const fixture = setup({
      trusted: false,
      value: makeProfileSettingsInspection({ projectTrusted: false }),
    });
    yield* step(() => fixture.settings("global automaticProfileRouting inherit"));
    const [patch] = featurePatches(fixture);
    expect(patch).toMatchObject({ scope: "global", expectedExists: false });
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("expectedDocument");
  });

  effectTest("has no session scope and changes nothing without a persistent one", function* () {
    const fixture = setup();
    for (const args of ["scriptedWorkflows false", "session automaticProfileRouting inherit"])
      yield* step(() => fixture.settings(args));
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.managerActions.patchSessionNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });

  effectTest("rejects values other than true, false, or inherit", function* () {
    const fixture = setup();
    for (const value of ["off", "1", "yes"])
      yield* step(() => fixture.settings(`global scriptedWorkflows ${value}`));
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
  });

  effectTest("refuses Project writes before trust and when trust is revoked", function* () {
    const untrusted = setup({ trusted: false });
    yield* step(() => untrusted.settings("project scriptedWorkflows false"));
    expect(untrusted.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(untrusted.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/trust/iu), "warning");

    const revoked = setup();
    const inspect = revoked.managerActions.inspectProfiles;
    vi.mocked(inspect).mockImplementationOnce((trusted) => {
      revoked.setProjectTrusted(false);
      return vi.mocked(inspect).getMockImplementation()!(trusted);
    });
    yield* step(() => revoked.settings("project scriptedWorkflows false"));
    expect(revoked.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(revoked.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/trust/iu), "error");
  });

  effectTest("reports a stale document conflict without claiming success", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.patchFeatureToggle).mockRejectedValueOnce(
      new SubagentConfigStoreError({
        operation: "update",
        path: "/agent/pi-subagents.json",
        message: "Subagents settings changed on disk; reopen /subagents profiles and try again.",
      }),
    );
    yield* step(() => fixture.settings("global scriptedWorkflows false"));
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
  });

  effectTest("a change from a replaced session cannot reach its successor", function* () {
    const fixture = setup();
    let current = true;
    vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
      isCurrent: () => current,
      run: (effect, signal) => Effect.runPromise(effect, { signal }),
    });
    const inspect = fixture.managerActions.inspectProfiles;
    vi.mocked(inspect).mockImplementationOnce((trusted) => {
      current = false;
      return vi.mocked(inspect).getMockImplementation()!(trusted);
    });
    yield* step(() => fixture.settings("global scriptedWorkflows false"));
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalled();
  });
});

describe("root /subagents fleet actions", () => {
  const question = { requestId: "q", message: "Which file?", createdAt: 1 };
  const topLevel = (overrides: Partial<SubagentRunView> = {}) =>
    view({ id: "child", name: "child", parentRunId: "root", depth: 1, ...overrides });

  /** Opens the registered root fleet over a fixed projection and the supplied manager actions. */
  const openFleet = function* (run: SubagentRunView, overrides: Partial<FleetManagerActions>) {
    let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = extensionApiFixture({
      registerCommand: (
        _name: string,
        definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        command = definition.handler;
      },
    });
    const managerActions = fleetManagerActionsFixture(overrides);
    const bridge = opaqueFixture({
      get: () => projectionOf([run]),
      subscribe: () => () => undefined,
    });
    registerSubagentManagerCommand(pi, bridge, managerActions);
    const overlays: Component[] = [];
    const { custom } = mountingCustomUi(plainTheme, (created) => overlays.push(created), {
      columns: 120,
      rows: 30,
    });
    const ctx = extensionContextFixture({
      cwd: "/repo",
      signal: undefined,
      hasUI: true,
      mode: "tui",
      ui: { notify: vi.fn(), custom },
    });
    const running = command?.("", ctx) ?? Promise.resolve();
    yield* step(() => vi.waitFor(() => expect(overlays).toHaveLength(1)));
    const fleet = overlays[0];
    if (!(fleet instanceof SubagentFleetComponent)) throw new Error("Expected the root fleet.");
    const settled = function* () {
      yield* step(() =>
        vi.waitFor(() => {
          expect(fleet.noticeKind).toBeDefined();
          expect(fleet.noticeKind).not.toBe("info");
        }),
      );
      return fleet.noticeKind;
    };
    const close = function* () {
      fleet.handleInput("\u001b");
      yield* step(() => running);
    };
    return { fleet, settled, close };
  };

  const sendOutcomes: ReadonlyArray<
    readonly [string, () => Promise<FleetMessageDelivery>, FleetNoticeKind]
  > = [
    ["delivered guidance as success", () => Promise.resolve("delivered"), "success"],
    ["pending guidance as pending, not failure", () => Promise.resolve("pending"), "warning"],
    ["a rejected send as an error", () => Promise.reject(new Error("rejected")), "error"],
  ];
  for (const [label, outcome, expected] of sendOutcomes)
    effectTest(`routes guidance to send and shows ${label}`, function* () {
      const send = vi.fn((_id: string, _message: string) => outcome());
      const reply = vi.fn((): Promise<void> => Promise.resolve());
      const { fleet, settled, close } = yield* openFleet(topLevel(), { send, reply });
      for (const key of ["m", "h", "i", "\r"]) fleet.handleInput(key);
      expect(yield* settled()).toBe(expected);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("child", "hi");
      expect(reply).not.toHaveBeenCalled();
      yield* close();
    });

  effectTest("routes a parent-question reply to reply and reports its success", function* () {
    const send = vi.fn((): Promise<FleetMessageDelivery> => Promise.resolve("pending"));
    const reply = vi.fn((_id: string, _message: string): Promise<void> => Promise.resolve());
    const { fleet, settled, close } = yield* openFleet(
      topLevel({ state: "waiting_for_parent", question }),
      { send, reply },
    );
    for (const key of ["m", "o", "k", "\r"]) fleet.handleInput(key);
    expect(yield* settled()).toBe("success");
    expect(reply).toHaveBeenCalledWith("child", "ok");
    expect(send).not.toHaveBeenCalled();
    yield* close();
  });
});
