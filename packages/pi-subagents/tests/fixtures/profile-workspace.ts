import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { ProfileCandidate } from "../../src/profiles/model.ts";
import type { SessionProfileOverrideSeed } from "../../src/profiles/session-overrides.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceOptions,
} from "../../src/settings/profile-workspace.ts";
import { makeProfileSettingsInspection } from "./profile-settings-inspection.ts";
import { profileCandidate } from "./profiles.ts";

/** Lets submitted workspace work settle for two scheduler turns. */
export const settleTurn = (): Promise<void> =>
  Effect.runPromise(Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow)));

/** A trusted inspection whose Global default set declares nothing. */
export const workspaceInspection = (seed?: SessionProfileOverrideSeed) =>
  makeProfileSettingsInspection(
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

/** Opens a shortcut's selector page, searches it, and chooses the first match. */
export const chooseFromPage = (
  component: { readonly handleInput: (data: string) => void },
  shortcut: string,
  query: string,
): void => {
  for (const key of [shortcut, "/", ...query, "\r"]) component.handleInput(key);
};

/** A Current Session generalist workspace whose saves replace its session route. */
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
  const loadModelPicker = vi.fn<ProfileWorkspaceOptions["loadModelPicker"]>(
    (profile, candidateIndex, candidate) =>
      Promise.resolve({
        choices: ["test/first", "test/second", "test/changed"].map((selector) => ({
          provider: "test",
          id: selector,
          selector,
          fastModeAvailable: false,
        })),
        current: candidate.model,
        context: { profile, candidateIndex, runtime: candidate.runtime },
      }),
  );
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
