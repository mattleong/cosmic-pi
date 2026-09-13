import type { Theme } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { describe, expect, it, vi } from "vitest";
import {
  runProfileSetAction,
  type ProfileSetActionHost,
} from "../src/settings/profile-set-actions.ts";
import { ProfileDashboardDialog } from "../src/settings/profile-dashboard-dialogs.ts";
import { ProfileDashboardComponent } from "../src/settings/profile-dashboard-component.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
} from "../src/settings/profile-workspace.ts";
import type { FleetManagerActions } from "../src/settings/controller.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import { extensionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, eventLoopTurn, step } from "./support/effect-test.ts";

// SAFETY: These components only call the three implemented Theme functions.
const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;
const inspection = () =>
  makeProfileSettingsInspection({
    globalDocument: { version: 6, profileSets: { common: { profiles: {} } } },
    projectDocument: { version: 6, profileSets: { common: { profiles: {} } } },
    projectTrusted: true,
  });
const fixture = () => {
  const value = inspection();
  const calls = {
    inspectProfiles: vi.fn(() => Promise.resolve(value)),
    replaceSessionProfiles: vi.fn(() => Promise.resolve()),
    replaceSessionProfilesWithReceipt: vi.fn(() => Promise.resolve(value.session)),
    createProfileSetFromSnapshot: vi.fn(() => Promise.resolve()),
    patchDefaultProfileSet: vi.fn(() => Promise.resolve()),
    copyProfileSet: vi.fn(() => Promise.resolve()),
    renameProfileSet: vi.fn(() => Promise.resolve()),
    deleteProfileSet: vi.fn(() => Promise.resolve()),
  };
  const unused = () => Promise.reject(new Error("Unexpected action"));
  const actions: FleetManagerActions = {
    ...calls,
    isAvailable: () => true,
    captureModelRefresh: () => ({
      isCurrent: () => true,
      run: (effect, signal) => Effect.runPromise(effect, { signal }),
    }),
    stop: unused,
    interrupt: unused,
    resume: unused,
    send: unused,
    reply: unused,
    rename: unused,
    patchProfile: unused,
    patchSessionProfile: unused,
    patchNesting: unused,
    patchSessionNesting: unused,
    inspectWriterWorkspace: unused,
    setWriterWorkspaceMode: unused,
    listNativeModels: unused,
  };
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
  effectTest(
    "previews all profiles and resets a successful no-op Use visit from its receipt",
    function* () {
      const f = fixture();
      yield* step(() =>
        runProfileSetAction(f.host, {
          action: "use-current",
          target: { scope: "global", name: "common" },
        }),
      );
      expect(f.calls.replaceSessionProfilesWithReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: f.value.session.revision }),
      );
      expect(f.calls.replaceSessionProfiles).not.toHaveBeenCalled();
      expect(f.host.used).toHaveBeenCalledWith(f.value, f.value);
      const preview = vi.mocked(f.host.confirm).mock.calls[0]![1];
      for (const profile of [
        "scout",
        "researcher",
        "planner",
        "worker",
        "reviewer",
        "oracle",
        "generalist",
      ])
        expect(preview).toContain(`${profile}:`);
    },
  );
  effectTest("rechecks trust and lifetime after confirmation before replacement", function* () {
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
          runProfileSetAction(host, {
            action: "use-current",
            target: { scope: "project", name: "common" },
          }),
        ).rejects.toThrow(),
      );
      expect(f.calls.replaceSessionProfilesWithReceipt).not.toHaveBeenCalled();
    }
  });
  effectTest("snapshot saving keeps defaults and editing target unchanged", function* () {
    const f = fixture();
    yield* step(() =>
      runProfileSetAction(f.host, { action: "save-session", preferredScope: "project" }),
    );
    expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDocument: f.value.projectDocument,
        expectedRevision: f.value.session.revision,
        profileSet: "snapshot",
      }),
    );
    expect(f.calls.patchDefaultProfileSet).not.toHaveBeenCalled();
    expect(f.host.used).not.toHaveBeenCalled();
  });
  effectTest(
    "does not rebase a rename onto a document changed during the name dialog",
    function* () {
      const f = fixture();
      yield* step(() =>
        runProfileSetAction(f.host, {
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
      expect(f.host.renamed).toHaveBeenCalled();
    },
  );
  effectTest("late mutation settlement cannot refresh or publish after disposal", function* () {
    const f = fixture();
    const gate = yield* Deferred.make<void>();
    f.calls.deleteProfileSet.mockImplementation(() => Effect.runPromise(Deferred.await(gate)));
    const pending = runProfileSetAction(f.host, {
      action: "delete",
      target: { scope: "global", name: "common" },
    });
    yield* step(() => Promise.resolve());
    f.revoke();
    yield* Deferred.succeed(gate, undefined);
    yield* step(() => expect(pending).rejects.toThrow());
    expect(f.host.refresh).not.toHaveBeenCalled();
    expect(f.host.deleted).not.toHaveBeenCalled();
  });
});

describe("internal dashboard dialogs", () => {
  it("requires scrolling the complete replacement before confirmation", () => {
    const close = vi.fn();
    const dialog = new ProfileDashboardDialog({
      theme,
      kind: "confirm",
      title: "Replace",
      body: Array.from({ length: 20 }, (_, index) => `profile ${index}`).join("\n"),
      getHeight: () => 8,
      requestRender: vi.fn(),
      close,
    });
    dialog.render(70);
    dialog.handleInput("\r");
    expect(close).not.toHaveBeenCalled();
    dialog.handleInput("\u001b[F");
    dialog.render(70);
    dialog.handleInput("\r");
    expect(close).toHaveBeenCalledWith(true);
  });
  it("text entry owns printable configured cancel bindings", () => {
    const close = vi.fn();
    const dialog = new ProfileDashboardDialog({
      theme,
      kind: "name",
      title: "Name",
      getHeight: () => 8,
      requestRender: vi.fn(),
      matchesKeybinding: (data, id) => data === "q" && id === "tui.select.cancel",
      close,
    });
    dialog.handleInput("q");
    dialog.handleInput("\r");
    expect(close).toHaveBeenCalledWith("q");
  });
  it("raw Escape still cancels when configured matcher returns false", () => {
    const close = vi.fn();
    const dialog = new ProfileDashboardDialog({
      theme,
      kind: "confirm",
      title: "Confirm",
      getHeight: () => 8,
      requestRender: vi.fn(),
      matchesKeybinding: () => false,
      close,
    });
    dialog.handleInput("\u001b");
    expect(close).toHaveBeenCalledWith(undefined);
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
      theme,
      inspection: f.value,
      projectTrusted: true,
      target: { kind: "session" },
      initialProfile: "worker",
      initialFocus: "fields",
      preferredPiModel: () => undefined,
      parentEffort: "high",
      getHeight: () => height,
      requestRender: vi.fn(),
      close,
      saveDraft,
      loadModelPicker: () => Promise.reject(new Error("unused")),
      supportedPiEfforts: () => undefined,
      fastModeAvailable: () => false,
    },
  });
  component.focused = true;
  return {
    ...f,
    component,
    close,
    saveDraft,
    setHeight: (next: number) => {
      height = next;
    },
  };
};

describe("persistent dashboard", () => {
  effectTest("conflict refresh advances the editable draft with its write guard", function* () {
    const f = dashboard();
    const worker = f.value.session.effectiveConfig.profiles.worker.candidates[0]!;
    const latest = makeProfileSettingsInspection(
      {
        globalDocument: f.value.globalDocument!,
        projectDocument: f.value.projectDocument!,
        projectTrusted: true,
      },
      {
        revision: 1,
        overrides: { worker: { candidates: [{ ...worker, model: "external/model" }] } },
      },
    );
    f.calls.inspectProfiles.mockResolvedValue(latest);
    f.component.handleInput("s");
    yield* step(eventLoopTurn);
    for (const letter of "snapshot") f.component.handleInput(letter);
    f.component.handleInput("\r");
    yield* step(eventLoopTurn);
    f.component.handleInput("e");
    f.component.handleInput("\u001b[A");
    f.component.handleInput("\r");
    yield* step(eventLoopTurn);
    expect(f.saveDraft).toHaveBeenCalledWith(
      { kind: "session" },
      "worker",
      expect.objectContaining({
        candidates: [expect.objectContaining({ model: "external/model" })],
      }),
      undefined,
    );
    f.component.dispose();
  });

  effectTest(
    "owned rename keeps inactive navigation and exact Undo through the dashboard",
    function* () {
      const f = dashboard();
      let name = "common";
      let profiles: JsonObject = {};
      let latest = f.value;
      const inspect = () =>
        makeProfileSettingsInspection({
          globalDocument: f.value.globalDocument!,
          projectDocument: { version: 6, profileSets: { [name]: { profiles } } },
          projectTrusted: true,
        });
      f.calls.inspectProfiles.mockImplementation(() => Promise.resolve(latest));
      f.saveDraft.mockImplementation((_target, profile, draft, restore) => {
        profiles = { ...profiles };
        if (restore) delete profiles[profile];
        else {
          const { openaiFastMode, ...candidate } = draft.candidates[0]!;
          profiles[profile] = {
            ...candidate,
            ...(openaiFastMode !== undefined && { openaiFastMode }),
          };
        }
        latest = inspect();
        return Promise.resolve({
          inspection: latest,
          receipt: { kind: "saved", document: latest.projectDocument! },
        });
      });
      f.calls.renameProfileSet.mockImplementation(() => {
        name = "renamed";
        latest = inspect();
        return Promise.resolve();
      });
      const press = (...keys: string[]) => {
        for (const key of keys) {
          f.component.handleInput(key);
          f.component.render(120);
        }
      };
      press("\t", "\r");
      press("e", "\u001b[A", "\r");
      yield* step(eventLoopTurn);
      expect(f.saveDraft).toHaveBeenCalledOnce();
      // Keep worker's Context row expanded while visiting reviewer's Reasoning row.
      press(
        "\u001b[B",
        "\u001b[B",
        "\u001b[B",
        "\r",
        "\u001b[B",
        "\u001b",
        "\u001b[B",
        "\r",
        "e",
        "\u001b",
      );
      press("\u001b", "\u001b[A", "\u001b", "a", "j", "j", "\r");
      yield* step(eventLoopTurn);
      press("\u0001", "\u000b", ..."renamed", "\r");
      yield* step(eventLoopTurn);
      expect(f.calls.renameProfileSet).toHaveBeenCalledWith(
        expect.objectContaining({ nextProfileSet: "renamed" }),
      );
      press("\r", "\r", "\r", "j", "\r");
      yield* step(eventLoopTurn);
      expect(f.saveDraft).toHaveBeenLastCalledWith(
        { kind: "profile-set", set: { scope: "project", name: "renamed" } },
        "worker",
        expect.objectContaining({ candidates: [expect.objectContaining({ context: "fork" })] }),
        undefined,
      );
      // Resizing and switching tabs retain the renamed editor and its Undo receipt.
      f.setHeight(24);
      expect(f.component.render(100).length).toBeLessThanOrEqual(24);
      press("\t", "\t");
      f.setHeight(35);
      expect(f.component.render(128).length).toBeLessThanOrEqual(35);
      expect(f.close).not.toHaveBeenCalled();
      // Undo remains owned after the rename and restores the originally absent declaration.
      press("G", "\r", "\r");
      yield* step(eventLoopTurn);
      expect(f.saveDraft).toHaveBeenLastCalledWith(
        { kind: "profile-set", set: { scope: "project", name: "renamed" } },
        "worker",
        expect.anything(),
        { sourceVersion: 6 },
      );
      press("\u001b", "\u001b[B", "\r", "\r", "\u001b[A", "\r");
      yield* step(eventLoopTurn);
      expect(f.saveDraft).toHaveBeenLastCalledWith(
        { kind: "profile-set", set: { scope: "project", name: "renamed" } },
        "reviewer",
        expect.objectContaining({ candidates: [expect.objectContaining({ effort: "max" })] }),
        undefined,
      );
      f.component.dispose();
    },
  );

  effectTest("activation invalidation settles an open dialog and closes its host", function* () {
    const f = dashboard();
    f.component.handleInput("s");
    yield* step(eventLoopTurn);
    f.revoke();
    f.component.handleInput("\u001b");
    yield* step(eventLoopTurn);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledWith(false);
    expect(f.component.render(80)).toEqual([]);
    f.component.handleInput("\r");
    expect(f.calls.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  effectTest(
    "observed deletion retires a cached editor before the same name is recreated",
    function* () {
      const disposed = vi.spyOn(ProfileWorkspaceComponent.prototype, "dispose");
      const f = dashboard();
      f.component.handleInput("\t");
      f.component.handleInput("\r");
      f.component.handleInput("\u001b");
      f.component.handleInput("\u001b");
      const deleted = makeProfileSettingsInspection({
        globalDocument: f.value.globalDocument!,
        projectDocument: { version: 6, profileSets: {} },
        projectTrusted: true,
      });
      f.calls.inspectProfiles.mockResolvedValue(deleted);
      f.component.handleInput("\u001b[B");
      f.component.handleInput("a");
      f.component.handleInput("\r");
      yield* step(eventLoopTurn);
      expect(disposed).toHaveBeenCalledTimes(1);
      f.calls.inspectProfiles.mockResolvedValue(f.value);
      f.component.handleInput("a");
      f.component.handleInput("\r");
      yield* step(eventLoopTurn);
      f.component.handleInput("\u001b[A");
      f.component.handleInput("\r");
      expect(f.close).not.toHaveBeenCalled();
      f.component.dispose();
      // Session, deleted saved editor, and recreated saved editor each have a distinct lifetime.
      expect(disposed).toHaveBeenCalledTimes(3);
      disposed.mockRestore();
    },
  );
  it("trust loss retires cached project editors before the saved tab can reopen them", () => {
    const disposed = vi.spyOn(ProfileWorkspaceComponent.prototype, "dispose");
    const f = dashboard();
    f.component.handleInput("\t");
    f.component.handleInput("\r");
    f.component.handleInput("\t");
    f.untrust();
    f.component.handleInput("\u001b[Z");
    f.component.handleInput("\r");
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.saveDraft).not.toHaveBeenCalled();
    f.component.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
    disposed.mockRestore();
  });
  effectTest("Tab switches targets from either pane while picker Tab stays local", function* () {
    for (const paneKey of ["h", "l"]) {
      const f = dashboard();
      f.component.handleInput(paneKey);
      f.component.handleInput("\t"); // One press opens the saved library.
      f.component.handleInput("\r"); // Edit its selected set.
      f.component.handleInput("e");
      f.component.handleInput("\t"); // This belongs to the picker, not the dashboard.
      f.component.handleInput("j");
      f.component.handleInput("\r");
      yield* step(eventLoopTurn);
      expect(f.saveDraft).toHaveBeenLastCalledWith(
        { kind: "profile-set", set: { scope: "project", name: "common" } },
        "worker",
        expect.anything(),
        undefined,
      );
      f.component.handleInput("\u001b[Z"); // Shift+Tab returns directly to Current Session.
      f.component.handleInput("e");
      f.component.handleInput("k");
      f.component.handleInput("\r");
      yield* step(eventLoopTurn);
      expect(f.saveDraft).toHaveBeenLastCalledWith(
        { kind: "session" },
        "worker",
        expect.anything(),
        undefined,
      );
      expect(f.calls.replaceSessionProfilesWithReceipt).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      f.component.dispose();
    }
  });

  it("tab navigation and saved editing never apply a set or close the host", () => {
    const f = dashboard();
    f.component.handleInput("\t");
    f.component.handleInput("\r");
    f.component.handleInput("s");
    expect(f.close).not.toHaveBeenCalled();
    expect(f.calls.replaceSessionProfilesWithReceipt).not.toHaveBeenCalled();
    expect(f.calls.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    f.component.dispose();
  });
  effectTest("serializes snapshot writes and blocks navigation while one is pending", function* () {
    const f = dashboard();
    const gate = yield* Deferred.make<void>();
    f.calls.createProfileSetFromSnapshot.mockImplementation(() =>
      Effect.runPromise(Deferred.await(gate)),
    );
    f.component.handleInput("s");
    yield* step(eventLoopTurn);
    for (const letter of "snapshot") f.component.handleInput(letter);
    f.component.handleInput("\r");
    yield* step(eventLoopTurn);
    expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledTimes(1);
    f.component.handleInput("s");
    f.component.handleInput("\t");
    f.component.handleInput("\u001b[C");
    f.component.handleInput("\r");
    yield* step(eventLoopTurn);
    expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    yield* Deferred.succeed(gate, undefined);
    yield* step(eventLoopTurn);
    f.component.dispose();
  });
  effectTest(
    "failed saved-set refresh blocks later edits until the dashboard closes",
    function* () {
      const f = dashboard();
      f.calls.inspectProfiles.mockRejectedValue(new Error("unavailable"));
      f.component.handleInput("s");
      yield* step(eventLoopTurn);
      for (const letter of "snapshot") f.component.handleInput(letter);
      f.component.handleInput("\r");
      yield* step(eventLoopTurn);
      f.component.handleInput("s");
      f.component.handleInput("\t");
      f.component.handleInput("\u001b[C");
      f.component.handleInput("\r");
      expect(f.calls.createProfileSetFromSnapshot).not.toHaveBeenCalled();
      expect(f.saveDraft).not.toHaveBeenCalled();
      f.component.handleInput("\u001b");
      expect(f.close).toHaveBeenCalledWith(false);
      f.component.dispose();
    },
  );
  effectTest(
    "keeps the left-pane save action selected after cancellation and tab switches",
    function* () {
      const f = dashboard();
      for (const key of ["h", "G", "\r"]) f.component.handleInput(key);
      yield* step(eventLoopTurn);
      f.component.handleInput("\u001b");
      yield* step(eventLoopTurn);
      expect(f.calls.createProfileSetFromSnapshot).not.toHaveBeenCalled();
      for (const key of ["\t", "\t", "\r"]) f.component.handleInput(key);
      yield* step(eventLoopTurn);
      for (const key of [..."snapshot", "\r"]) f.component.handleInput(key);
      yield* step(eventLoopTurn);
      expect(f.calls.createProfileSetFromSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ profileSet: "snapshot" }),
      );
      expect(f.saveDraft).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      f.component.dispose();
    },
  );

  effectTest("disposing an internal save form makes its late input inert", function* () {
    const f = dashboard();
    f.component.handleInput("s");
    yield* step(() => Promise.resolve());
    f.component.dispose();
    f.component.handleInput("name");
    f.component.handleInput("\r");
    yield* step(() => Promise.resolve());
    expect(f.calls.createProfileSetFromSnapshot).not.toHaveBeenCalled();
    expect(f.component.render(80)).toEqual([]);
  });
});
