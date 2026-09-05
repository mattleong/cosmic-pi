import { resolveSubagentConfig } from "../../src/config/options.ts";
import { decodeSubagentConfig } from "../../src/config/schema.ts";
import {
  makeSessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../../src/profiles/session-overrides.ts";
import type { ProfileSettingsInspection } from "../../src/settings/profile-route-editor.ts";

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
  const global = decodeSubagentConfig(globalDocument, "global");
  const project =
    projectDocument === undefined ? undefined : decodeSubagentConfig(projectDocument, "project");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted,
    globalConfigExists: globalDocument !== undefined,
    projectConfigExists: projectDocument !== undefined,
    global,
    project,
  });
  return {
    config,
    global,
    project,
    globalDocument,
    projectDocument,
    session: makeSessionProfileSnapshot(config, seed),
  };
};
