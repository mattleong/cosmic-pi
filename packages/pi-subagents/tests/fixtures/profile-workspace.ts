import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { extensionContextFixture, plainTheme } from "pi-cosmic-core/testing";
import type { ProfileCandidate } from "../../src/profiles/model.ts";
import type { SessionProfileOverrideSeed } from "../../src/profiles/session-overrides.ts";
import type { SubagentCommandActions } from "../../src/settings/controller.ts";
import { ProfileDashboardComponent } from "../../src/settings/profile-dashboard-component.ts";
import type { ProfileSettingsInspection } from "../../src/settings/profile-route-editor.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
} from "../../src/settings/profile-workspace.ts";
import { profileSettingsInspection } from "./profile-settings-inspection.ts";
import { profileCandidate } from "./profiles.ts";
import * as Arr from "effect/Array";

export const settleTurn = (): Promise<void> =>
  Effect.runPromise(Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow)));

export const workspaceInspection = (seed?: SessionProfileOverrideSeed) =>
  profileSettingsInspection(
    {
      globalDocument: {
        version: 6,
        defaultProfileSet: "default",
        profileSets: { default: { profiles: {} } },
      },
      projectTrusted: true,
    },
    seed,
  );

export const chooseFromPage = (
  component: { readonly handleInput: (data: string) => void },
  shortcut: string,
  query: string,
): void => {
  for (const key of [shortcut, "/", ...Array.from(query), "\r"]) component.handleInput(key);
};

export const workspaceHarness = (
  overrides: Partial<ProfileWorkspaceOptions> = {},
  initial: ReadonlyArray<ProfileCandidate> = [
    profileCandidate("test/first"),
    profileCandidate("test/second"),
  ],
) => {
  let candidates = initial;
  const inspection = () =>
    workspaceInspection({ revision: 1, overrides: { generalist: { candidates } } });
  const close = vi.fn();
  const saveSession = vi.fn();
  const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>((_target, _profile, draft) => {
    candidates = draft.candidates;
    return Promise.resolve({ inspection: inspection() });
  });
  const loadModelPicker = vi.fn<ProfileWorkspaceOptions["loadModelPicker"]>(() => ({
    choices: Arr.map(["test/first", "test/second", "test/changed"], (selector) => ({
      provider: "test",
      id: selector,
      selector,
      fastModeAvailable: false,
    })),
  }));
  const component = new ProfileWorkspaceComponent({
    theme: plainTheme,
    inspection: inspection(),
    target: { kind: "session" },
    initialProfile: "generalist",
    parentEffort: "high",
    getHeight: () => 24,
    requestRender: vi.fn(),
    close,
    saveSession,
    saveDraft,
    loadModelPicker,
    supportedPiEfforts: () => ["low", "high"],
    ...overrides,
  });
  return {
    component,
    close,
    saveSession,
    saveDraft,
    loadModelPicker,
    candidates: () => candidates,
    inspection,
  };
};

/** A focused profile dashboard over `inspection`, with its editor opened on the current session. */
export const dashboardHarness = (options: {
  readonly inspection: ProfileSettingsInspection;
  readonly actions: SubagentCommandActions;
  readonly trusted?: () => boolean;
  readonly isCurrent?: () => boolean;
  readonly workspace?: Partial<ProfileWorkspaceOptions>;
}) => {
  const close = vi.fn();
  const saveDraft = vi.fn<ProfileWorkspaceOptions["saveDraft"]>(() =>
    Promise.resolve({ inspection: options.inspection }),
  );
  const component = new ProfileDashboardComponent({
    ctx: extensionContextFixture({ isProjectTrusted: options.trusted ?? (() => true) }),
    actions: options.actions,
    isCurrent: options.isCurrent ?? (() => true),
    onInspection: vi.fn(),
    awaitDialog: (register) =>
      Effect.runPromise(
        Effect.callback((resume) => {
          const cleanup = register((result) => resume(Effect.succeed(result)));
          return Effect.sync(cleanup);
        }),
      ),
    workspace: {
      theme: plainTheme,
      inspection: options.inspection,
      target: { kind: "session" },
      parentEffort: "high",
      getHeight: () => 40,
      requestRender: vi.fn(),
      close,
      saveDraft,
      loadModelPicker: () => ({ choices: [] }),
      supportedPiEfforts: () => undefined,
      ...options.workspace,
    },
  });
  component.focused = true;
  return {
    component,
    close,
    saveDraft,
    press: (...keys: string[]) => {
      for (const key of keys) component.handleInput(key);
    },
  };
};
