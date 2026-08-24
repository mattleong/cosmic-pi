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
  const global = decodeSubagentConfig({ version: 4 }, "global");
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
  component.handleInput("d");
};

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
        initialScope: "session",
        requestRender,
        close,
        clearSessionOverrides,
      }),
    );

    component.handleInput("X");
    component.handleInput("X");
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
