import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveSubagentConfig } from "../../src/config/options.ts";
import { subagentConfigDecoder } from "../../src/config/schema.ts";
import type { ProfileCandidate } from "../../src/profiles/model.ts";
import {
  sessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../../src/profiles/session-overrides.ts";
import type { SubagentCommandActions } from "../../src/settings/controller.ts";
import type { ProfileSettingsInspection } from "../../src/settings/profile-route-editor.ts";
import { declaredCandidate } from "./profiles.ts";

export const jsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.MutableJson),
);

export type ConfigDocumentValue =
  | Schema.Json
  | ProfileCandidate
  | ReadonlyArray<ConfigDocumentValue>
  | { readonly [key: string]: ConfigDocumentValue | undefined };

export const resolveTestConfig = (
  globalDocument: ConfigDocumentValue | undefined,
  projectDocument?: ConfigDocumentValue,
  projectTrusted = true,
) =>
  resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted,
    global: subagentConfigDecoder("global")(globalDocument),
    project:
      projectDocument === undefined ? undefined : subagentConfigDecoder("project")(projectDocument),
  });

export const profileSettingsInspection = (
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
    global: subagentConfigDecoder("global")(globalDocument),
    project:
      projectDocument === undefined ? undefined : subagentConfigDecoder("project")(projectDocument),
    globalDocument,
    projectDocument,
    session: sessionProfileSnapshot(config, seed),
  };
};

export const INVALID_ROUTE = declaredCandidate("parent", { effort: "impossible" });

const unexpectedAction = () => Promise.reject(new Error("Unexpected action"));

export const subagentCommandActionsFixture = (
  overrides: Partial<SubagentCommandActions>,
): SubagentCommandActions => {
  return {
    isAvailable: () => true,
    captureAuthority: () => overrides.captureModelRefresh?.().isCurrent ?? (() => true),
    captureModelRefresh: () => ({
      isCurrent: () => true,
      run: (effect, signal) => Effect.runPromise(effect, { signal }),
    }),
    openActivity: unexpectedAction,
    inspectProfiles: unexpectedAction,
    patchProfile: unexpectedAction,
    restoreProfileDeclaration: unexpectedAction,
    patchDefaultProfileSet: unexpectedAction,
    createProfileSetFromSnapshot: unexpectedAction,
    copyProfileSet: unexpectedAction,
    renameProfileSet: unexpectedAction,
    deleteProfileSet: unexpectedAction,
    patchNesting: unexpectedAction,
    patchDelegation: unexpectedAction,
    inspectWriterWorkspace: unexpectedAction,
    runDoctor: unexpectedAction,
    setWriterWorkspaceMode: unexpectedAction,
    patchSessionProfile: unexpectedAction,
    replaceSessionProfiles: unexpectedAction,
    patchSessionNesting: unexpectedAction,
    patchSessionDelegation: unexpectedAction,
    ...overrides,
  };
};
