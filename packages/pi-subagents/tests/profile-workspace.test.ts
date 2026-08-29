import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import {
  makeSessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../src/profiles/session-overrides.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
  type ProfileWorkspaceSaveResult,
} from "../src/settings/profile-workspace.ts";

const makeInspection = (seed?: SessionProfileOverrideSeed) => {
  const global = decodeSubagentConfig(
    { version: 6, defaultProfileSet: "default", profileSets: { default: { profiles: {} } } },
    "global",
  );
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: false,
    global,
  });
  return { config, global, session: makeSessionProfileSnapshot(config, seed) };
};

// SAFETY: These behavior tests never render theme-dependent rows before disposal assertions.
const theme = {} as Theme;

const baseOptions = (
  overrides: Partial<ProfileWorkspaceOptions> = {},
): ProfileWorkspaceOptions => ({
  theme,
  inspection: makeInspection(),
  projectTrusted: true,
  target: { kind: "profile-set", set: { scope: "global", name: "default" } },
  parentEffort: "high",
  preferredPiModel: () => "openai-codex/gpt-5.6-sol",
  getHeight: () => 40,
  requestRender: () => {},
  close: () => {},
  saveDraft: () => Promise.resolve({ inspection: makeInspection() }),
  clearSessionOverrides: () => Promise.resolve({ inspection: makeInspection() }),
  loadModelPicker: (_profile, candidateIndex, candidate) =>
    Promise.resolve({
      choices: [],
      current: candidate.model,
      context: {
        profile: "generalist",
        candidateIndex,
        host: candidate.host,
        runtime: candidate.runtime,
      },
    }),
  supportedPiEfforts: () => undefined,
  fastModeAvailable: () => false,
  reload: () => Promise.resolve(false),
  ...overrides,
});

const settleContinuations = (): Promise<void> =>
  Effect.runPromise(Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow)));

const submitDisable = (component: ProfileWorkspaceComponent): void => {
  component.handleInput("\r");
  component.handleInput("d");
  component.handleInput("\r");
};

describe("profile workspace navigation", () => {
  it("preserves the initial profile and reload state in a scope request", () => {
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        target: { kind: "session" },
        initialProfile: "researcher",
        initialReloadRequired: true,
        close,
      }),
    );

    component.handleInput("3");

    expect(close).toHaveBeenCalledWith({
      action: "scope",
      scope: "global",
      profile: "researcher",
      reloadRequired: true,
    });
  });

  it("opens Sets from the Profiles page with the current dashboard state", () => {
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        target: { kind: "profile-set", set: { scope: "project", name: "project-default" } },
        initialProfile: "planner",
        initialReloadRequired: true,
        close,
      }),
    );

    component.handleInput("s");

    expect(close).toHaveBeenCalledWith({
      action: "sets",
      profile: "planner",
      reloadRequired: true,
      preferredScope: "project",
    });
  });

  it("maps numeric shortcuts to Session, Project, and Global scopes", () => {
    const requests: unknown[] = [];
    const persistentTarget = {
      kind: "profile-set" as const,
      set: { scope: "global" as const, name: "default" },
    };
    for (const [key, target] of [
      ["1", persistentTarget],
      ["2", persistentTarget],
      ["3", { kind: "session" as const }],
    ] as const) {
      const component = new ProfileWorkspaceComponent(
        baseOptions({ target, close: (result) => requests.push(result) }),
      );
      component.handleInput(key);
    }

    expect(requests).toEqual(
      ["session", "project", "global"].map((scope) => ({
        action: "scope",
        scope,
        profile: "generalist",
        reloadRequired: false,
      })),
    );
  });

  it("rejects Project navigation when the project is untrusted", () => {
    const close = vi.fn();
    const requestRender = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        target: { kind: "session" },
        projectTrusted: false,
        close,
        requestRender,
      }),
    );

    component.handleInput("2");

    expect(close).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalled();
  });
});

describe("profile workspace confirmation", () => {
  it("keeps destructive confirmation armed until configured confirm executes it", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    component.handleInput("\r");
    component.handleInput("d");
    component.handleInput("z");
    component.handleInput("\r");

    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("cancels destructive confirmation with Escape", () => {
    const saveDraft = vi.fn(() => Promise.resolve({ inspection: makeInspection() }));
    const component = new ProfileWorkspaceComponent(baseOptions({ saveDraft }));

    component.handleInput("\r");
    component.handleInput("d");
    component.handleInput("\u001b");
    component.handleInput("d");
    component.handleInput("\r");

    expect(saveDraft).toHaveBeenCalledTimes(1);
  });
});

describe("profile workspace disposal", () => {
  it("lets submitted persistence settle but discards every late UI continuation", () => {
    const saveCell = Deferred.makeUnsafe<ProfileWorkspaceSaveResult>();
    let persistenceSettled = false;
    const save = Effect.runPromise(Deferred.await(saveCell)).then((result) => {
      persistenceSettled = true;
      return result;
    });
    const requestRender = vi.fn();
    const close = vi.fn();
    const onDispose = vi.fn();
    const saveDraft = vi.fn(() => save);
    const component = new ProfileWorkspaceComponent(
      baseOptions({ requestRender, close, onDispose, saveDraft }),
    );

    submitDisable(component);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    component.dispose();
    component.dispose();
    const rendersAtDispose = requestRender.mock.calls.length;
    component.handleInput("d");
    component.invalidate();
    expect(component.render(100)).toEqual([]);

    Deferred.doneUnsafe(saveCell, Effect.succeed({ inspection: makeInspection() }));
    return settleContinuations().then(() => {
      expect(persistenceSettled).toBe(true);
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(close).not.toHaveBeenCalled();
      expect(saveDraft).toHaveBeenCalledTimes(1);
      expect(onDispose).toHaveBeenCalledTimes(1);
    });
  });

  it("aborts model loading and ignores its late result", () => {
    type PickerData = Awaited<ReturnType<ProfileWorkspaceOptions["loadModelPicker"]>>;
    const pickerCell = Deferred.makeUnsafe<PickerData>();
    const picker = Effect.runPromise(Deferred.await(pickerCell));
    let capturedSignal: AbortSignal | undefined;
    const requestRender = vi.fn();
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        requestRender,
        close,
        loadModelPicker: (_profile, _index, _candidate, signal) => {
          capturedSignal = signal;
          return picker;
        },
      }),
    );

    component.handleInput("\r");
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("\r");
    expect(capturedSignal).toBeDefined();
    component.dispose();
    expect(capturedSignal?.aborted).toBe(true);
    const rendersAtDispose = requestRender.mock.calls.length;
    Deferred.doneUnsafe(
      pickerCell,
      Effect.succeed({
        choices: [],
        current: "parent",
        context: {
          profile: "generalist",
          candidateIndex: 0,
          host: "local",
          runtime: "pi",
        },
      }),
    );
    return settleContinuations().then(() => {
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(close).not.toHaveBeenCalled();
    });
  });

  it("reports a terminal reloaded outcome after applying persistent changes", () => {
    const close = vi.fn();
    const reload = vi.fn(() => Promise.resolve(true));
    const component = new ProfileWorkspaceComponent(baseOptions({ close, reload }));
    submitDisable(component);
    return settleContinuations()
      .then(() => {
        component.handleInput("r");
        return settleContinuations();
      })
      .then(() => {
        expect(reload).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith("reloaded");
      });
  });

  it("does not close or render when reload settles after disposal", () => {
    const reloadCell = Deferred.makeUnsafe<boolean>();
    const reload = Effect.runPromise(Deferred.await(reloadCell));
    const requestRender = vi.fn();
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({ requestRender, close, reload: () => reload }),
    );

    submitDisable(component);
    return settleContinuations().then(() => {
      component.handleInput("r");
      component.dispose();
      const rendersAtDispose = requestRender.mock.calls.length;
      Deferred.doneUnsafe(reloadCell, Effect.succeed(true));
      return settleContinuations().then(() => {
        expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
        expect(close).not.toHaveBeenCalled();
      });
    });
  });

  it("lets clear-session persistence settle without reviving a disposed workspace", () => {
    const inherited = makeInspection();
    const generalist = inherited.session.baseConfig.profiles.generalist;
    const inspection = makeInspection({ revision: 1, overrides: { generalist } });
    const clearCell = Deferred.makeUnsafe<ProfileWorkspaceSaveResult>();
    let clearSettled = false;
    const clear = Effect.runPromise(Deferred.await(clearCell)).then((result) => {
      clearSettled = true;
      return result;
    });
    const clearSessionOverrides = vi.fn(() => clear);
    const requestRender = vi.fn();
    const close = vi.fn();
    const component = new ProfileWorkspaceComponent(
      baseOptions({
        inspection,
        target: { kind: "session" },
        requestRender,
        close,
        clearSessionOverrides,
      }),
    );

    component.handleInput("X");
    component.handleInput("\r");
    expect(clearSessionOverrides).toHaveBeenCalledTimes(1);
    component.dispose();
    const rendersAtDispose = requestRender.mock.calls.length;
    Deferred.doneUnsafe(clearCell, Effect.succeed({ inspection: makeInspection() }));
    return settleContinuations().then(() => {
      expect(clearSettled).toBe(true);
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(close).not.toHaveBeenCalled();
    });
  });
});
