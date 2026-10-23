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
import { subagentConfigDecoder } from "../../src/config/schema.ts";
import type { ProfileCandidate } from "../../src/profiles/model.ts";
import {
  sessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../../src/profiles/session-overrides.ts";
import type { FleetManagerActions } from "../../src/settings/controller.ts";
import type { ProfileSettingsInspection } from "../../src/settings/profile-route-editor.ts";
import { SubagentFleetComponent } from "../../src/ui/fleet.ts";
import { step } from "../support/effect-test.ts";
import { mountingCustomUi } from "./pi-host.ts";
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

export const fleetManagerActionsFixture = (
  overrides: Partial<FleetManagerActions>,
): FleetManagerActions => {
  return {
    isAvailable: () => true,
    captureAuthority: () => overrides.captureModelRefresh?.().isCurrent ?? (() => true),
    captureModelRefresh: () => ({
      isCurrent: () => true,
      run: (effect, signal) => Effect.runPromise(effect, { signal }),
    }),
    stop: unexpectedAction,
    interrupt: unexpectedAction,
    resume: unexpectedAction,
    send: unexpectedAction,
    rename: unexpectedAction,
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
    listNativeModels: unexpectedAction,
    ...overrides,
  };
};

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
  return { fleet, press, settled, close, completion: running };
};
