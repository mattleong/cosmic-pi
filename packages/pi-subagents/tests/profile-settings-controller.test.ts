import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { describe, expect, vi } from "vitest";
import {
  deferredPromise,
  extensionContextFixture,
  plainTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { subagentProjectionBridge } from "../src/boundary/host-ui.ts";
import {
  fleetManagerActionsFixture,
  profileSettingsInspection,
  openRegisteredFleet,
} from "./fixtures/profile-settings-inspection.ts";
import { SubagentConfigConflictError, SubagentConfigStoreError } from "../src/config/store.ts";
import {
  sessionProfileSnapshot,
  SessionProfileConflictError,
  SessionProfileInvalidError,
} from "../src/profiles/session-overrides.ts";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import { ProfileDashboardComponent } from "../src/settings/profile-dashboard-component.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import { mountingCustomUi } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";
import { effectTest, step } from "./support/effect-test.ts";

type DisposableComponent = Component & { readonly dispose?: (() => void) | undefined };

const inspectionDocument = (defaultProfileSet: string, own: string) => ({
  version: 6,
  defaultProfileSet,
  profileSets: { common: { profiles: {} }, [own]: { profiles: {} } },
});

const inspection = (globalDefault = "global"): ProfileSettingsInspection => {
  return profileSettingsInspection({
    globalDocument: inspectionDocument(globalDefault, "global"),
    projectDocument: inspectionDocument("project", "project"),
    projectTrusted: true,
  });
};

const atSessionRevision = (
  value: ProfileSettingsInspection,
  revision: number,
): ProfileSettingsInspection => ({
  ...value,
  session: sessionProfileSnapshot(value.config, { revision, overrides: {} }),
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
    patchDelegation: vi.fn(() => Promise.resolve()),
    inspectWriterWorkspace: vi.fn(() => Promise.resolve({ mode: "worktree" as const })),
    setWriterWorkspaceMode: vi.fn(() => Promise.resolve()),
    patchSessionProfile: vi.fn(() => Promise.resolve(value.session)),
    replaceSessionProfiles: vi.fn(() => Promise.resolve(value.session)),
    patchSessionNesting: vi.fn(() => Promise.resolve()),
    patchSessionDelegation: vi.fn(() => Promise.resolve()),
    listNativeModels: () => Promise.resolve([]),
  });

const setup = (
  options: {
    readonly trusted?: boolean;
    readonly value?: ProfileSettingsInspection;
  } = {},
) => {
  const { pi, commands } = recordingExtensionHost();
  let projectTrusted = options.trusted ?? true;
  const overlays: DisposableComponent[] = [];
  const { custom } = mountingCustomUi(plainTheme, (component) => overlays.push(component), {
    columns: 120,
    rows: 30,
  });
  const managerActions = actions(options.value ?? inspection());
  registerSubagentManagerCommand(pi, subagentProjectionBridge(), managerActions);
  let customImplementation: ExtensionUIContext["custom"] = custom;
  let customCalls = 0;
  const countedCustom: ExtensionUIContext["custom"] = (factory, customOptions) => {
    customCalls += 1;
    return customImplementation(factory, customOptions);
  };
  const ui = { notify: vi.fn<ExtensionUIContext["notify"]>(), custom: countedCustom };
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
    command: commands.get("subagents")?.handler,
    settings: (args: string) =>
      commands.get("subagents")?.handler(`settings ${args}`, ctx) ?? Promise.resolve(),
    completions: commands.get("subagents")?.getArgumentCompletions,
    ctx,
    overlays,
    ui,
    customCalls: () => customCalls,
    useCustom: (implementation: ExtensionUIContext["custom"]) => {
      customImplementation = implementation;
    },
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
  expect(fixture.customCalls()).toBe(1);
};
const saveSnapshot = function* (fixture: ReturnType<typeof setup>) {
  press(fixture, "s");
  yield* step(settleHostPromises);
  press(fixture, ...Array.from("snapshot"), "\r");
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
const onNextInspection = (fixture: ReturnType<typeof setup>, sideEffect: () => void) => {
  const inspect = vi.mocked(fixture.managerActions.inspectProfiles);
  const configured = inspect.getMockImplementation()!;
  inspect.mockImplementationOnce((trusted) => {
    sideEffect();
    return configured(trusted);
  });
};

describe("profile settings controller", () => {
  effectTest(
    "activation shutdown before mount waits to close without popping a stacked overlay",
    function* () {
      const fixture = setup();
      const host = fakeCustomSurfaceHost({ theme: plainTheme, columns: 120, rows: 30 });
      fixture.useCustom((factory, options) => host.ctx.ui.custom(factory, options));
      const activation = replaceableActivation(fixture);
      const running = fixture.command?.("profiles", fixture.ctx) ?? Promise.resolve();
      yield* step(() => vi.waitFor(() => expect(fixture.customCalls()).toBe(1)));
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

  effectTest("rejects a stale Session replacement without retrying", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.replaceSessionProfiles).mockRejectedValueOnce(
      SessionProfileConflictError.make({
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

  for (const outcome of ["conflict", "invalid"] as const)
    effectTest(`a Session edit ${outcome} keeps its own recovery`, function* () {
      const fixture = setup();
      const running = yield* openDashboard(fixture);
      const inspect = vi.mocked(fixture.managerActions.inspectProfiles);
      const patch = vi.mocked(fixture.managerActions.patchSessionProfile);
      inspect.mockClear();
      const reason = "Sentinel rejection reason.";
      patch.mockRejectedValueOnce(
        outcome === "conflict"
          ? SessionProfileConflictError.make({
              expectedRevision: 0,
              actualRevision: 1,
              message: reason,
            })
          : SessionProfileInvalidError.make({ message: reason }),
      );
      const changeEffort = function* () {
        press(fixture, "e");
        yield* step(settleHostPromises);
        press(fixture, "j", "\r");
        yield* step(settleHostPromises);
      };
      yield* changeEffort();
      expect(patch).toHaveBeenCalledTimes(1);
      const screen = fixture.overlays[0]?.render(120).join("\n") ?? "";
      if (outcome === "conflict") {
        // A conflict refreshes to the latest Session and lets the user retry the edit.
        expect(inspect).toHaveBeenCalledTimes(1);
        yield* changeEffort();
        expect(patch).toHaveBeenCalledTimes(2);
      } else {
        expect(inspect).not.toHaveBeenCalled();
        expect(screen).toContain(reason);
      }
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

  for (const outcome of ["refresh", "refresh-failure", "other-error"] as const) {
    effectTest(`saved-set write handles ${outcome} without retrying the edit`, function* () {
      const fixture = setup();
      const running = yield* openLibrary(fixture);
      press(fixture, "\r");
      const updated = profileSettingsInspection({
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
        outcome === "other-error"
          ? SubagentConfigStoreError.make({
              operation: "update",
              path: "/repo/.pi/subagents.json",
              message: "permission denied",
            })
          : SubagentConfigConflictError.make({
              path: "/repo/.pi/subagents.json",
              message: "changed on disk",
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

  effectTest("changes the workspace default while workspaces remain unresolved", function* () {
    const fixture = setup();
    vi.mocked(fixture.managerActions.inspectWriterWorkspace).mockResolvedValue({
      mode: "worktree",
      unresolvedWorkspaceCount: 2,
    });
    yield* step(() => fixture.settings("writerWorkspace shared-checkout"));
    expect(fixture.managerActions.setWriterWorkspaceMode).toHaveBeenCalledWith("shared-checkout");
    expect(fixture.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "error");
  });

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

  effectTest("changes one nesting limit while the scope's other limits stay", function* () {
    const sessionWith = (nesting: { maxDirectChildren?: number; maxDepth?: number }) =>
      setup({
        value: profileSettingsInspection(
          {
            globalDocument: inspectionDocument("global", "global"),
            projectDocument: inspectionDocument("project", "project"),
            projectTrusted: true,
          },
          { revision: 0, overrides: {}, nesting },
        ),
      });
    const partial = sessionWith({ maxDirectChildren: 4, maxDepth: 2 });
    yield* step(() => partial.settings("session maxDepth inherit"));
    expect(partial.managerActions.patchSessionNesting).toHaveBeenCalledWith(
      expect.objectContaining({ nesting: { maxDirectChildren: 4 } }),
    );

    const set = sessionWith({ maxDepth: 2 });
    yield* step(() => set.settings("session maxActiveRuns 8"));
    expect(set.managerActions.patchSessionNesting).toHaveBeenCalledWith(
      expect.objectContaining({ nesting: { maxDepth: 2, maxActiveRuns: 8 } }),
    );

    // Once the scope declares no limit, it inherits the whole policy.
    const last = sessionWith({ maxDepth: 2 });
    yield* step(() => last.settings("session maxDepth inherit"));
    expect(
      vi.mocked(last.managerActions.patchSessionNesting).mock.calls[0]?.[0],
    ).not.toHaveProperty("nesting");
  });

  effectTest("rechecks Project trust before a Project delegation write", function* () {
    const fixture = setup();
    onNextInspection(fixture, () => fixture.setProjectTrusted(false));
    yield* step(() => fixture.settings("project delegation encouraged"));
    expect(fixture.managerActions.patchDelegation).not.toHaveBeenCalled();
    expect(fixture.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/trust/iu), "error");
  });
});

const openFleet = (run: SubagentRunView, overrides: Partial<FleetManagerActions>) => {
  const bridge = subagentProjectionBridge();
  bridge.publish(projectionOf([run]));
  return openRegisteredFleet((pi) =>
    registerSubagentManagerCommand(pi, bridge, fleetManagerActionsFixture(overrides)),
  );
};

const topLevel = (overrides: Partial<SubagentRunView> = {}) =>
  view({ id: "child", name: "child", parentRunId: "root", depth: 1, ...overrides });

describe("root /subagents fleet actions", () => {
  effectTest("closes an idle fleet when its command is cancelled", function* () {
    const { pi, commands } = recordingExtensionHost();
    // An empty fleet has no refresh ticker or projection change to notice the cancellation.
    registerSubagentManagerCommand(pi, subagentProjectionBridge(), fleetManagerActionsFixture({}));
    const host = fakeCustomSurfaceHost({ theme: plainTheme, columns: 120, rows: 30 });
    const command = new AbortController();
    const ctx = extensionContextFixture({
      hasUI: true,
      mode: "tui",
      ui: host.ctx.ui,
      signal: command.signal,
    });
    const running = commands.get("subagents")?.handler("", ctx) ?? Promise.resolve();
    yield* step(() =>
      vi.waitFor(() => {
        host.mount();
        expect(host.overlays).toHaveLength(1);
      }),
    );
    command.abort();
    yield* step(() => running);
    expect(host.overlays).toEqual([]);
    expect(host.doneCalls).toBe(1);
  });

  effectTest(
    "does not dispatch a retained fleet control into a replacement activation",
    function* () {
      let current = true;
      const stop = vi.fn(() => Promise.resolve());
      const fixture = yield* openFleet(topLevel(), {
        stop,
        captureModelRefresh: () => ({
          isCurrent: () => current,
          run: (effect, signal) => Effect.runPromise(effect, { signal }),
        }),
      });
      fixture.press("x");
      current = false;
      fixture.press("\r");
      expect(stop).not.toHaveBeenCalled();
      expect(fixture.fleet.render(120)).toEqual([]);
      yield* fixture.close();
    },
  );
});
