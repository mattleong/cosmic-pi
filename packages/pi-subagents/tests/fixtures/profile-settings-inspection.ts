import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  extensionContextFixture,
  plainTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { expect, vi } from "vitest";
import { resolveSubagentConfig } from "../../src/config/options.ts";
import { decodeSubagentConfig } from "../../src/config/schema.ts";
import type { ProfileId } from "../../src/profiles/model.ts";
import {
  makeSessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../../src/profiles/session-overrides.ts";
import type { FleetManagerActions } from "../../src/settings/controller.ts";
import type { ProfileSettingsInspection } from "../../src/settings/profile-route-editor.ts";
import { SubagentFleetComponent } from "../../src/ui/fleet.ts";
import { step } from "../support/effect-test.ts";
import { mountingCustomUi } from "./pi-host.ts";
import { declaredCandidate } from "./profiles.ts";

/** Decodes a test document literal into the JSON object a store reads. */
export const jsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.MutableJson),
);

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
    patchFeatureToggle: unused,
    patchSessionFeatureToggle: unused,
    inspectWriterWorkspace: unused,
    setWriterWorkspaceMode: unused,
    patchSessionProfile: unused,
    replaceSessionProfiles: unused,
    patchSessionNesting: unused,
    listNativeModels: unused,
    ...overrides,
  };
};

/** Opens a registered `/subagents` fleet in a mounted terminal, driven by keys. */
export const openRegisteredFleet = function* (register: (pi: ExtensionAPI) => void, columns = 120) {
  const { pi, commands } = recordingExtensionHost();
  register(pi);
  const overlays: Component[] = [];
  const { custom } = mountingCustomUi(plainTheme, (created) => overlays.push(created), {
    columns,
    rows: 30,
  });
  const ctx = extensionContextFixture({
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn(), custom },
  });
  const running = commands.get("subagents")?.handler("", ctx) ?? Promise.resolve();
  yield* step(() => vi.waitFor(() => expect(overlays).toHaveLength(1)));
  const fleet = overlays[0];
  if (!(fleet instanceof SubagentFleetComponent)) throw new Error("Expected the fleet.");
  const press = (...keys: string[]) => {
    for (const key of keys) {
      fleet.handleInput(key);
      fleet.render(columns);
    }
  };
  /** Waits for the one in-flight action to settle into a final outcome. */
  const settled = function* () {
    yield* step(() =>
      vi.waitFor(() => expect([undefined, "info"]).not.toContain(fleet.noticeKind)),
    );
    return fleet.noticeKind;
  };
  const close = function* () {
    press("\u001b");
    yield* step(() => running);
  };
  return { fleet, press, settled, close };
};
