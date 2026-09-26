import * as Effect from "effect/Effect";
import { resolveSubagentConfig } from "../../src/config/options.ts";
import { decodeSubagentConfig } from "../../src/config/schema.ts";
import type { ProfileId } from "../../src/profiles/model.ts";
import {
  makeSessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../../src/profiles/session-overrides.ts";
import type { FleetManagerActions } from "../../src/settings/controller.ts";
import type { ProfileSettingsInspection } from "../../src/settings/profile-route-editor.ts";
import { declaredCandidate } from "./profiles.ts";

/** Decodes and resolves Global and optional Project documents at fixed fake paths. */
export const resolveTestConfig = <GlobalDocument, ProjectDocument>(
  globalDocument: GlobalDocument,
  projectDocument?: ProjectDocument,
  projectTrusted = true,
) =>
  resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted,
    global: decodeSubagentConfig(globalDocument, "global"),
    project:
      projectDocument === undefined ? undefined : decodeSubagentConfig(projectDocument, "project"),
  });

export const makeProfileSettingsInspection = (
  {
    globalDocument,
    projectDocument,
    projectTrusted,
  }: Pick<ProfileSettingsInspection, "globalDocument" | "projectDocument"> & {
    readonly projectTrusted: boolean;
  },
  seed?: SessionProfileOverrideSeed,
): ProfileSettingsInspection => {
  const config = resolveTestConfig(globalDocument, projectDocument, projectTrusted);
  return {
    config,
    global: decodeSubagentConfig(globalDocument, "global"),
    project:
      projectDocument === undefined ? undefined : decodeSubagentConfig(projectDocument, "project"),
    globalDocument,
    projectDocument,
    session: makeSessionProfileSnapshot(config, seed),
  };
};

/** A route that stays repairable but fails closed on its impossible effort. */
export const INVALID_ROUTE = declaredCandidate("parent", { effort: "impossible" });

/** A trusted Project default set "partial" that inherits, or also owns, an invalid Global route. */
export const inheritedInvalidInspection = (
  ownInvalid = false,
  profile: ProfileId = "worker",
): ProfileSettingsInspection =>
  makeProfileSettingsInspection({
    globalDocument: {
      version: 6,
      defaultProfileSet: "lower",
      profileSets: { lower: { profiles: { [profile]: INVALID_ROUTE } } },
    },
    projectDocument: {
      version: 6,
      defaultProfileSet: "partial",
      profileSets: { partial: { profiles: ownInvalid ? { [profile]: INVALID_ROUTE } : {} } },
    },
    projectTrusted: true,
  });

/** Manager actions that reject every call a suite does not supply as an override. */
export const fleetManagerActionsFixture = (
  overrides: Partial<FleetManagerActions>,
): FleetManagerActions => {
  const unused = () => Promise.reject(new Error("Unexpected action"));
  return {
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
    inspectProfiles: unused,
    patchProfile: unused,
    restoreProfileDeclaration: unused,
    patchDefaultProfileSet: unused,
    createProfileSetFromSnapshot: unused,
    copyProfileSet: unused,
    renameProfileSet: unused,
    deleteProfileSet: unused,
    patchNesting: unused,
    inspectWriterWorkspace: unused,
    setWriterWorkspaceMode: unused,
    patchSessionProfile: unused,
    replaceSessionProfiles: unused,
    patchSessionNesting: unused,
    listNativeModels: unused,
    ...overrides,
  };
};
