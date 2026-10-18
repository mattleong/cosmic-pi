import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import {
  runProfileSetAction,
  type ProfileSetActionHost,
} from "../src/settings/profile-set-actions.ts";
import { ProfileDashboardComponent } from "../src/settings/profile-dashboard-component.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
} from "../src/settings/profile-workspace.ts";
import {
  fleetManagerActionsFixture,
  profileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { deferredPromise, extensionContextFixture, plainTheme } from "pi-cosmic-core/testing";
import { effectTest, eventLoopTurn, step } from "./support/effect-test.ts";

const inspection = () =>
  profileSettingsInspection({
    globalDocument: { version: 6, profileSets: { common: { profiles: {} } } },
    projectDocument: { version: 6, profileSets: { common: { profiles: {} } } },
    projectTrusted: true,
  });
const fixture = () => {
  const value = inspection();
  const calls = {
    inspectProfiles: vi.fn(() => Promise.resolve(value)),
    replaceSessionProfiles: vi.fn(() => Promise.resolve(value.session)),
    createProfileSetFromSnapshot: vi.fn(() => Promise.resolve()),
    patchDefaultProfileSet: vi.fn(() => Promise.resolve()),
    copyProfileSet: vi.fn(() => Promise.resolve()),
    renameProfileSet: vi.fn(() => Promise.resolve()),
    deleteProfileSet: vi.fn(() => Promise.resolve()),
  };
  const actions = fleetManagerActionsFixture(calls);
  let current = true;
  let trusted = true;
  const host: ProfileSetActionHost = {
    actions,
    inspection: () => value,
    isCurrent: () => current,
    trusted: () => trusted,
    refresh: vi.fn(() => Promise.resolve(value)),
    confirm: vi.fn(() => Promise.resolve(true)),
    name: vi.fn(() => Promise.resolve("renamed")),
    save: vi.fn(() => Promise.resolve({ scope: "project" as const, name: "snapshot" })),
    used: vi.fn(),
    renamed: vi.fn(),
    deleted: vi.fn(),
    notify: vi.fn(),
  };
  return {
    value,
    host,
    calls,
    revoke: () => {
      current = false;
    },
    untrust: () => {
      trusted = false;
    },
  };
};

describe("profile dashboard actions", () => {
  effectTest("never applies or selects a saved set containing an invalid route", function* () {
    const f = fixture();
    const invalid = profileSettingsInspection({
      globalDocument: {
        version: 6,
        profileSets: {
          common: {
            profiles: {
              worker: {
                runtime: "herdr",
                model: "native",
                effort: "default",
                context: "fresh",
                writeIntent: "writer",
              },
            },
          },
        },
      },
      projectTrusted: true,
    });
    const host = { ...f.host, inspection: () => invalid, refresh: () => Promise.resolve(invalid) };
    for (const action of ["use-current", "make-default"] as const)
      yield* step(() =>
        expect(
          runProfileSetAction(host, { action, target: { scope: "global", name: "common" } }),
        ).rejects.toThrow(),
      );
    expect(f.calls.replaceSessionProfiles).not.toHaveBeenCalled();
    expect(f.calls.patchDefaultProfileSet).not.toHaveBeenCalled();
  });
  effectTest(
    "rechecks trust and lifetime after confirming a replacement or deletion",
    function* () {
      for (const action of ["use-current", "delete"] as const)
        for (const revoke of ["untrust", "revoke"] as const) {
          const f = fixture();
          const host = {
            ...f.host,
            confirm: () => {
              f[revoke]();
              return Promise.resolve(true);
            },
          };
          yield* step(() =>
            expect(
              runProfileSetAction(host, { action, target: { scope: "project", name: "common" } }),
            ).rejects.toThrow(),
          );
          expect(f.calls.replaceSessionProfiles).not.toHaveBeenCalled();
          expect(f.calls.deleteProfileSet).not.toHaveBeenCalled();
        }
    },
  );
  effectTest(
    "does not rebase a rename onto a document changed during the name dialog",
    function* () {
      const f = fixture();
      const changed = profileSettingsInspection({
        globalDocument: {
          version: 6,
          profileSets: { common: { profiles: {} }, external: { profiles: {} } },
        },
        projectTrusted: true,
      });
      let displayed = f.value;
      const host = {
        ...f.host,
        inspection: () => displayed,
        refresh: () => Promise.resolve(displayed),
        name: () =>
          Promise.resolve("renamed").then((name) => {
            displayed = changed;
            return name;
          }),
      };
      yield* step(() =>
        runProfileSetAction(host, {
          action: "rename",
          target: { scope: "global", name: "common" },
        }),
      );
      expect(f.calls.renameProfileSet).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedDocument: f.value.globalDocument,
          nextProfileSet: "renamed",
        }),
      );
      expect(f.host.renamed).toHaveBeenCalledWith(
        { kind: "profile-set", set: { scope: "global", name: "common" } },
        { kind: "profile-set", set: { scope: "global", name: "renamed" } },
        changed,
      );
    },
  );
  effectTest("late mutation settlement cannot refresh or publish after disposal", function* () {
    const f = fixture();
    const gate = deferredPromise();
    f.calls.deleteProfileSet.mockImplementation(() => gate.promise);
    const pending = runProfileSetAction(f.host, {
      action: "delete",
      target: { scope: "global", name: "common" },
    });
    yield* step(eventLoopTurn);
    expect(f.calls.deleteProfileSet).toHaveBeenCalledOnce();
    f.revoke();
    gate.resolve();
    yield* step(() => expect(pending).rejects.toThrow());
    expect(f.host.refresh).not.toHaveBeenCalled();
    expect(f.host.deleted).not.toHaveBeenCalled();
  });
});

const dashboard = () => {
  const f = fixture();
  const close = vi.fn();
  const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>(() =>
    Promise.resolve({ inspection: f.value }),
  );
  let height = 35;
  const component = new ProfileDashboardComponent({
    ctx: extensionContextFixture({ isProjectTrusted: f.host.trusted }),
    actions: f.host.actions,
    isCurrent: f.host.isCurrent,
    onInspection: vi.fn(),
    awaitDialog: (register) =>
      Effect.runPromise(
        Effect.callback((resume) => {
          const cleanup = register((value) => resume(Effect.succeed(value)));
          return Effect.sync(cleanup);
        }),
      ),
    workspace: {
      theme: plainTheme,
      inspection: f.value,
      target: { kind: "session" },
      initialProfile: "worker",
      initialFocus: "fields",
      parentEffort: "high",
      getHeight: () => height,
      requestRender: vi.fn(),
      close,
      saveDraft,
      loadModelPicker: () => Promise.reject(new Error("unused")),
      supportedPiEfforts: () => undefined,
    },
  });
  component.focused = true;
  return {
    ...f,
    component,
    press: (...keys: string[]) => {
      for (const key of keys) component.handleInput(key);
    },
    close,
    saveDraft,
    setHeight: (next: number) => {
      height = next;
    },
  };
};

const saveSnapshot = function* (f: ReturnType<typeof dashboard>) {
  f.press("s");
  yield* step(eventLoopTurn);
  f.press(...Array.from("snapshot"), "\r");
  yield* step(eventLoopTurn);
};

describe("persistent dashboard", () => {
  effectTest("activation invalidation settles an open dialog and closes its host", function* () {
    const f = dashboard();
    f.component.handleInput("s");
    yield* step(eventLoopTurn);
    f.revoke();
    f.component.handleInput("\u001b");
    yield* step(eventLoopTurn);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.component.render(80)).toEqual([]);
    f.component.handleInput("\r");
    expect(f.calls.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("trust loss retires cached project editors before the saved tab can reopen them", () => {
    const disposed = vi.spyOn(ProfileWorkspaceComponent.prototype, "dispose");
    const f = dashboard();
    f.press("\t", "\r", "\t");
    f.untrust();
    f.press("\u001b[Z", "\r");
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.saveDraft).not.toHaveBeenCalled();
    f.component.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
    disposed.mockRestore();
  });
  effectTest("serializes snapshot writes and blocks navigation while one is pending", function* () {
    const f = dashboard();
    const gate = deferredPromise();
    f.calls.createProfileSetFromSnapshot.mockImplementation(() => gate.promise);
    yield* saveSnapshot(f);
    expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledTimes(1);
    f.press("s", "\t", "\u001b[C", "\r");
    yield* step(eventLoopTurn);
    expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    gate.resolve();
    yield* step(eventLoopTurn);
    f.component.dispose();
  });
  effectTest("an untrusted save cannot toggle away from Global", function* () {
    const f = dashboard();
    f.untrust();
    f.component.handleInput("s");
    yield* step(eventLoopTurn);
    f.press(...Array.from("snapshot"), "\u001b[A", "\u001b[B", "\r");
    yield* step(eventLoopTurn);
    expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "global", profileSet: "snapshot" }),
    );
    expect(f.close).not.toHaveBeenCalled();
    f.component.dispose();
  });
});
