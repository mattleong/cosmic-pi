import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { describe, expect, vi } from "vitest";
import {
  deferredPromise,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import {
  fleetManagerActionsFixture,
  makeProfileSettingsInspection,
  openRegisteredFleet,
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
import type { FleetMessageDelivery, FleetNoticeKind } from "../src/ui/fleet.ts";
import { extensionApiFixture, mountingCustomUi } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";
import { effectTest, step } from "./support/effect-test.ts";

type DisposableComponent = Component & { readonly dispose?: (() => void) | undefined };

/** Global and Project documents with a shared `common` set and a default set each. */
const inspection = (globalDefault = "global"): ProfileSettingsInspection => {
  const document = (defaultProfileSet: string, own: string) => ({
    version: 6,
    defaultProfileSet,
    profileSets: { common: { profiles: {} }, [own]: { profiles: {} } },
  });
  return makeProfileSettingsInspection({
    globalDocument: document(globalDefault, "global"),
    projectDocument: document("project", "project"),
    projectTrusted: true,
  });
};

const untrustedInspection = (defaultProfileSet: string | [], profileSet: string) =>
  makeProfileSettingsInspection({
    globalDocument: {
      version: 6,
      defaultProfileSet,
      profileSets: { [profileSet]: { profiles: {} } },
    },
    projectTrusted: false,
  });
const invalidSourceInspection = () => untrustedInspection("missing", "valid");
const malformedGlobalDefaultInspection = () => untrustedInspection([], "common");

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
    patchSessionFeatureToggle: vi.fn(() => Promise.resolve()),
    inspectWriterWorkspace: vi.fn(() => Promise.resolve({ mode: "worktree" as const })),
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
  const ui = { notify: vi.fn(), custom: vi.fn(custom) };
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
const saveSnapshot = function* (fixture: ReturnType<typeof setup>) {
  press(fixture, "s");
  yield* step(settleHostPromises);
  press(fixture, ..."snapshot", "\r");
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
/** Settings and dashboard work belong to this activation until the test replaces it. */
const replaceableActivation = (fixture: ReturnType<typeof setup>) => {
  const activation = new AbortController();
  const runs = vi.fn();
  vi.spyOn(fixture.managerActions, "captureModelRefresh").mockReturnValue({
    isCurrent: () => !activation.signal.aborted,
    run: (effect, signal) => {
      runs();
      return Effect.runPromise(effect, { signal: AbortSignal.any([signal, activation.signal]) });
    },
  });
  return { replace: () => activation.abort(), runs };
};
/** Runs a side effect as the next profile inspection starts. */
const onNextInspection = (fixture: ReturnType<typeof setup>, sideEffect: () => void) => {
  const inspect = vi.mocked(fixture.managerActions.inspectProfiles);
  const configured = inspect.getMockImplementation()!;
  inspect.mockImplementationOnce((trusted) => {
    sideEffect();
    return configured(trusted);
  });
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
      const activation = replaceableActivation(fixture);
      const running = yield* openDashboard(fixture);
      press(fixture, "s");
      yield* step(settleHostPromises);
      activation.replace();
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
      const activation = replaceableActivation(fixture);
      const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
      yield* step(() => vi.waitFor(() => expect(fixture.ui.custom).toHaveBeenCalledOnce()));
      const questionnaire = { render: () => ["questionnaire"], invalidate() {} };
      host.showUnrelated(questionnaire);
      activation.replace();
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

  for (const outcome of ["settles", "fails"] as const)
    effectTest(
      `stays closed and quiet when a replaced owner's inspection ${outcome}`,
      function* () {
        const fixture = setup();
        const activation = replaceableActivation(fixture);
        const pending = deferredPromise<ProfileSettingsInspection>();
        vi.mocked(fixture.managerActions.inspectProfiles).mockReturnValue(pending.promise);
        const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
        activation.replace();
        if (outcome === "settles") pending.resolve(inspection());
        else pending.reject(new Error("Subagents session was replaced."));
        yield* step(() => running);
        expect(fixture.overlays).toEqual([]);
        expect(activation.runs).not.toHaveBeenCalled();
        // A replaced session's stale context cannot report its own replacement.
        expect(fixture.ui.notify).not.toHaveBeenCalled();
      },
    );

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
      const pending = deferredPromise<ProfileSettingsInspection>();
      const inspect = vi.mocked(fixture.managerActions.inspectProfiles);
      inspect.mockClear();
      inspect.mockReturnValueOnce(pending.promise);
      if (action === "snapshot") yield* saveSnapshot(fixture);
      else makeDefault(fixture);
      yield* step(settleHostPromises);
      expect(inspect).toHaveBeenCalledTimes(1);
      fixture.setProjectTrusted(false);
      pending.resolve(inspection());
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
    const activation = replaceableActivation(fixture);
    vi.mocked(fixture.managerActions.inspectWriterWorkspace).mockImplementationOnce(() => {
      activation.replace();
      return Promise.resolve({ mode: "worktree" });
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
    onNextInspection(fixture, () => fixture.setProjectTrusted(false));
    yield* step(() => fixture.settings("project maxDepth 2"));
    expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/trust/iu), "error");
  });

  effectTest(
    "fills a saved scope's other limit from what it inherits, never the session's",
    function* () {
      const fixture = setup({
        value: makeProfileSettingsInspection(
          {
            globalDocument: { version: 6, nesting: { maxDirectChildren: 6, maxDepth: 1 } },
            projectDocument: { version: 6 },
            projectTrusted: true,
          },
          { revision: 0, overrides: {}, nesting: { maxDirectChildren: 2, maxDepth: 3 } },
        ),
      });
      yield* step(() => fixture.settings("project maxDepth 4"));
      yield* step(() => fixture.settings("global maxDepth 5"));
      expect(
        vi.mocked(fixture.managerActions.patchNesting).mock.calls.map(([patch]) => patch.nesting),
      ).toEqual([
        { maxDirectChildren: 6, maxDepth: 4 },
        { maxDirectChildren: 6, maxDepth: 5 },
      ]);
      const unset = setup({ value: makeProfileSettingsInspection({ projectTrusted: false }) });
      yield* step(() => unset.settings("global maxDepth 5"));
      expect(vi.mocked(unset.managerActions.patchNesting).mock.calls[0]?.[0].nesting).toEqual({
        maxDirectChildren: 12,
        maxDepth: 5,
      });
    },
  );

  effectTest("reports only the scopes its own inspection could read", function* () {
    const fixture = setup({ trusted: false });
    onNextInspection(fixture, () => fixture.setProjectTrusted(true));
    yield* step(() => fixture.settings("status"));
    const [report] = fixture.ui.notify.mock.calls.at(-1) ?? [];
    expect(report).toContain("global:");
    expect(report).not.toMatch(/^\s*project:/mu);
  });

  effectTest("restores a picker row whose change was refused", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.setWriterWorkspaceMode).mockRejectedValueOnce(
      new Error("Writer reservation acquired"),
    );
    const running = fixture.settings("");
    yield* step(() => vi.waitFor(() => expect(fixture.overlays).toHaveLength(1)));
    const workspaceRow = () =>
      fixture.overlays[0]?.render(120).find((line) => line.includes("Writer workspace"));
    expect(workspaceRow()).toContain("worktree");
    press(fixture, " ");
    yield* step(settleHostPromises);
    expect(fixture.managerActions.setWriterWorkspaceMode).toHaveBeenCalledWith("shared-checkout");
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(workspaceRow()).toContain("worktree");
    press(fixture, " ");
    yield* step(settleHostPromises);
    expect(workspaceRow()).toContain("shared-checkout");
    press(fixture, "\u001b");
    yield* step(() => running);
  });
});

describe("feature switch settings", () => {
  const featurePatches = (fixture: ReturnType<typeof setup>) =>
    vi.mocked(fixture.managerActions.patchFeatureToggle).mock.calls.map(([patch]) => patch);

  effectTest("saves ultracode to either named scope against its inspected document", function* () {
    const fixture = setup();
    const value = inspection();
    yield* step(() => fixture.settings("global ultracode false"));
    yield* step(() => fixture.settings("project ultracode true"));
    expect(featurePatches(fixture)).toEqual([
      {
        scope: "global",
        toggle: "ultracode",
        enabled: false,
        expectedExists: true,
        expectedDocument: value.globalDocument,
        projectTrusted: true,
      },
      {
        scope: "project",
        toggle: "ultracode",
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
    yield* step(() => fixture.settings("global ultracode inherit"));
    const [patch] = featurePatches(fixture);
    expect(patch).toMatchObject({ scope: "global", expectedExists: false });
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("expectedDocument");
  });

  effectTest("sets the session's own value by default and clears it with inherit", function* () {
    const fixture = setup();
    for (const args of ["ultracode true", "session ultracode inherit"])
      yield* step(() => fixture.settings(args));
    expect(
      vi
        .mocked(fixture.managerActions.patchSessionFeatureToggle)
        .mock.calls.map(([patch]) => patch),
    ).toEqual([
      { toggle: "ultracode", enabled: true, expectedRevision: 0 },
      { toggle: "ultracode", expectedRevision: 0 },
    ]);
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.managerActions.patchSessionNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "error");
  });

  effectTest("rejects retired switch commands without writing any scope", function* () {
    const fixture = setup();
    for (const retired of ["automaticProfileRouting", "scriptedWorkflows"])
      for (const scope of ["global", "project", "session"])
        for (const value of ["true", "false", "inherit"])
          yield* step(() => fixture.settings(`${scope} ${retired} ${value}`));
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.managerActions.patchSessionFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.managerActions.patchNesting).not.toHaveBeenCalled();
    expect(fixture.managerActions.patchSessionNesting).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
  });

  effectTest("rejects values other than true, false, or inherit", function* () {
    const fixture = setup();
    for (const value of ["off", "1", "yes"])
      yield* step(() => fixture.settings(`global ultracode ${value}`));
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
  });

  effectTest("refuses Project writes before trust and when trust is revoked", function* () {
    const untrusted = setup({ trusted: false });
    yield* step(() => untrusted.settings("project ultracode false"));
    expect(untrusted.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(untrusted.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/trust/iu), "warning");

    const revoked = setup();
    onNextInspection(revoked, () => revoked.setProjectTrusted(false));
    yield* step(() => revoked.settings("project ultracode false"));
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
    yield* step(() => fixture.settings("global ultracode false"));
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
  });

  effectTest("a change from a replaced session cannot reach its successor", function* () {
    const fixture = setup();
    const activation = replaceableActivation(fixture);
    onNextInspection(fixture, activation.replace);
    yield* step(() => fixture.settings("global ultracode false"));
    expect(fixture.managerActions.patchFeatureToggle).not.toHaveBeenCalled();
    expect(fixture.ui.notify).not.toHaveBeenCalled();
  });
});

describe("root /subagents fleet actions", () => {
  const question = { requestId: "q", message: "Which file?" };
  const topLevel = (overrides: Partial<SubagentRunView> = {}) =>
    view({ id: "child", name: "child", parentRunId: "root", depth: 1, ...overrides });

  /** Opens the registered root fleet over a fixed projection and the supplied manager actions. */
  const openFleet = (run: SubagentRunView, overrides: Partial<FleetManagerActions>) =>
    openRegisteredFleet((pi) =>
      registerSubagentManagerCommand(
        pi,
        opaqueFixture({ get: () => projectionOf([run]), subscribe: () => () => undefined }),
        fleetManagerActionsFixture(overrides),
      ),
    );

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
      const { press, settled, close } = yield* openFleet(topLevel(), { send, reply });
      press("m", "h", "i", "\r");
      expect(yield* settled()).toBe(expected);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("child", "hi");
      expect(reply).not.toHaveBeenCalled();
      yield* close();
    });

  effectTest("routes a parent-question reply to reply and reports its success", function* () {
    const send = vi.fn((): Promise<FleetMessageDelivery> => Promise.resolve("pending"));
    const reply = vi.fn((_id: string, _message: string): Promise<void> => Promise.resolve());
    const { press, settled, close } = yield* openFleet(
      topLevel({ state: "waiting_for_parent", question }),
      { send, reply },
    );
    press("m", "o", "k", "\r");
    expect(yield* settled()).toBe("success");
    expect(reply).toHaveBeenCalledWith("child", "ok");
    expect(send).not.toHaveBeenCalled();
    yield* close();
  });
});
