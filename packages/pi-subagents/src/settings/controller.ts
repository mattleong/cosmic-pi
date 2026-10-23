import type { DoctorCheck } from "../application/doctor.ts";
import * as Arr from "effect/Array";
import type * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withCapturedHostSignal } from "pi-cosmic-core/host-invocation";
import { captureHostSignal, notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { registerExtensionCommand, type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import { type JsonObject } from "pi-cosmic-core/platform/json-document";
import type { SubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { SubagentControlExpectation } from "../run/model.ts";
import type { WriterWorkspaceInspection } from "../run/workspace-control.ts";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type {
  SubagentCopyProfileSetPatch,
  SubagentCreateProfileSetFromSnapshotPatch,
  SubagentDefaultProfileSetPatch,
  SubagentDelegationPatch,
  SubagentDeleteProfileSetPatch,
  SubagentNestingPatch,
  SubagentProfilePatch,
  SubagentProfileRestorePatch,
  SubagentRenameProfileSetPatch,
} from "../config/store.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import type {
  SessionDelegationPatch,
  SessionNestingPatch,
  SessionProfilePatch,
  SessionProfileSetPatch,
  SessionProfileSnapshot,
} from "../profiles/session-overrides.ts";
import type { FleetMessageDelivery } from "../ui/fleet.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { SUBAGENT_SETTINGS_COMMAND } from "./subagent-settings-options.ts";

interface SessionProfileSetSnapshotWrite extends Omit<
  SubagentCreateProfileSetFromSnapshotPatch,
  "profiles"
> {
  readonly expectedRevision: number;
}

export interface FleetManagerActions {
  readonly captureAuthority: () => () => boolean;
  readonly openActivity?: (signal?: AbortSignal) => Promise<boolean>;
  readonly isAvailable: () => boolean;
  readonly captureModelRefresh: () => {
    readonly isCurrent: () => boolean;
    readonly run: <A>(effect: Effect.Effect<A>, signal: AbortSignal) => Promise<A>;
  };
  readonly stop: (id: string, expected: SubagentControlExpectation) => Promise<void>;
  readonly interrupt: (id: string, expected: SubagentControlExpectation) => Promise<void>;
  readonly resume: (
    id: string,
    message: string | undefined,
    expected: SubagentControlExpectation,
  ) => Promise<void>;
  readonly send: (
    id: string,
    message: string,
    expected: SubagentControlExpectation,
  ) => Promise<FleetMessageDelivery>;
  readonly rename: (
    id: string,
    name: string,
    expected: SubagentControlExpectation,
  ) => Promise<void>;
  readonly inspectProfiles: (projectTrusted: boolean) => Promise<ProfileSettingsInspection>;
  readonly patchProfile: (patch: SubagentProfilePatch) => Promise<JsonObject>;
  readonly restoreProfileDeclaration: (patch: SubagentProfileRestorePatch) => Promise<JsonObject>;
  readonly patchDefaultProfileSet: (patch: SubagentDefaultProfileSetPatch) => Promise<void>;
  readonly createProfileSetFromSnapshot: (patch: SessionProfileSetSnapshotWrite) => Promise<void>;
  readonly copyProfileSet: (patch: SubagentCopyProfileSetPatch) => Promise<void>;
  readonly renameProfileSet: (patch: SubagentRenameProfileSetPatch) => Promise<void>;
  readonly deleteProfileSet: (patch: SubagentDeleteProfileSetPatch) => Promise<void>;
  readonly patchNesting: (patch: SubagentNestingPatch) => Promise<void>;
  readonly patchDelegation: (patch: SubagentDelegationPatch) => Promise<void>;
  readonly inspectWriterWorkspace: () => Promise<WriterWorkspaceInspection>;
  readonly runDoctor: (ctx: ExtensionCommandContext) => Promise<ReadonlyArray<DoctorCheck>>;
  readonly setWriterWorkspaceMode: (mode: WriterWorkspaceMode) => Promise<void>;
  readonly patchSessionProfile: (patch: SessionProfilePatch) => Promise<SessionProfileSnapshot>;
  readonly replaceSessionProfiles: (
    patch: SessionProfileSetPatch,
  ) => Promise<SessionProfileSnapshot>;
  readonly patchSessionNesting: (patch: SessionNestingPatch) => Promise<void>;
  readonly patchSessionDelegation: (patch: SessionDelegationPatch) => Promise<void>;
  readonly listNativeModels: (
    runtime: LocalCliRuntime,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<NativeRuntimeModel>>;
}

interface SubagentCommandModules {
  readonly fleet: () => Promise<typeof import("./fleet-manager.ts")>;
  readonly profiles: () => Promise<typeof import("./profile-dashboard.ts")>;
  readonly settings: () => Promise<typeof import("./subagent-settings.ts")>;
  readonly doctor: () => Promise<
    Pick<typeof import("../application/doctor.ts"), "formatDoctorReport">
  >;
}

const COMMAND_MODULES: SubagentCommandModules = {
  fleet: () => import("./fleet-manager.ts"),
  profiles: () => import("./profile-dashboard.ts"),
  settings: () => import("./subagent-settings.ts"),
  doctor: () => import("../application/doctor.ts"),
};

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  modules: SubagentCommandModules = COMMAND_MODULES,
): void {
  // A single settings owner preserves write serialization after the first lazy load.
  let settings: ExtensionSubcommand | undefined;
  const invoke = (
    ctx: ExtensionCommandContext,
    operation: (invocation: ExtensionCommandContext, isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> => {
    const authority = actions.captureAuthority();
    const captured = captureHostSignal(ctx);
    if (!Predicate.isTagged(captured, "Captured")) return Promise.resolve();
    const { signal } = captured;
    const isCurrent = () => authority() && !signal?.aborted;
    if (!isCurrent()) return Promise.resolve();
    const invocation = withCapturedHostSignal(ctx, signal);
    return operation(invocation, isCurrent).catch((cause: unknown) => {
      if (isCurrent()) throw cause;
    });
  };
  const openFleet = (ctx: ExtensionCommandContext, isCurrent: () => boolean): Promise<void> => {
    if (!isCurrent()) return Promise.resolve();
    return modules
      .fleet()
      .then(({ openFleetManager }) =>
        isCurrent() ? openFleetManager(ctx, bridge, actions) : undefined,
      );
  };
  registerExtensionCommand(pi, {
    name: "subagents",
    description: "Open the subagent fleet, or edit profiles and settings",
    bare: {
      handler: (_args, ctx) =>
        invoke(ctx, (invocation, isCurrent) => {
          if (invocation.mode !== "tui") {
            if (invocation.hasUI)
              notifyAtHostBoundary(
                invocation,
                "Open Pi in an interactive terminal to use /subagents",
                "warning",
              );
            return Promise.resolve();
          }
          if (!actions.isAvailable()) {
            notifyAtHostBoundary(
              invocation,
              "Subagents aren't running; run /reload, then reopen /subagents",
              "warning",
            );
            return Promise.resolve();
          }
          return actions.openActivity
            ? actions
                .openActivity(invocation.signal)
                .then((opened) => (opened ? undefined : openFleet(invocation, isCurrent)))
            : openFleet(invocation, isCurrent);
        }),
    },
    subcommands: [
      {
        name: "profiles",
        description: "Edit Current Session profiles and saved sets",
        arguments: "[profile]",
        complete: (prefix) => {
          const matches = Fn.pipe(
            PROFILE_IDS,
            Arr.filter((profile) => Fn.pipe(profile, Str.startsWith(Str.trim(prefix)))),
            Arr.map((profile) => ({
              value: profile,
              label: profile,
              description: `Edit ${profile} in Current Session`,
            })),
          );
          return matches.length ? matches : null;
        },
        handler: (args, ctx) =>
          invoke(ctx, (invocation, isCurrent) => {
            const parts = Fn.pipe(args, Str.trim, Str.split(/\s+/u), Arr.filter(Boolean));
            const profile = Option.getOrUndefined(
              Arr.findFirst(PROFILE_IDS, (id) => id === parts[0]),
            );
            if (parts.length > 1 || (parts.length === 1 && !profile)) {
              notifyAtHostBoundary(
                invocation,
                `Usage: /subagents profiles [${Arr.join(PROFILE_IDS, "|")}]`,
                "warning",
              );
              return Promise.resolve();
            }
            return modules.profiles().then(({ openProfileDashboard }) =>
              isCurrent()
                ? openProfileDashboard(pi, invocation, actions, {
                    initialProfile: profile ?? PROFILE_IDS[0],
                    initialFocus: profile ? "fields" : "profiles",
                  })
                : undefined,
            );
          }),
      },
      {
        ...SUBAGENT_SETTINGS_COMMAND,
        handler: (args, ctx) =>
          invoke(ctx, (invocation, isCurrent) =>
            modules.settings().then(({ subagentSettingsSubcommand }) => {
              if (!isCurrent()) return undefined;
              settings ??= subagentSettingsSubcommand(actions);
              return settings.handler(args, invocation);
            }),
          ),
      },
      {
        name: "doctor",
        description: "Check subagent setup and route readiness",
        handler: (_args, ctx) =>
          invoke(ctx, (invocation, isCurrent) =>
            modules
              .doctor()
              .then(({ formatDoctorReport }) => {
                if (!isCurrent()) return undefined;
                return actions
                  .runDoctor(invocation)
                  .then((checks) =>
                    isCurrent()
                      ? notifyAtHostBoundary(
                          invocation,
                          formatDoctorReport(checks),
                          Arr.some(checks, (item) => item.status !== "ok") ? "warning" : "info",
                        )
                      : undefined,
                  );
              })
              .catch(() => {
                if (isCurrent())
                  notifyAtHostBoundary(
                    invocation,
                    "Subagents doctor couldn't run; run /reload and try again",
                    "error",
                  );
              }),
          ),
      },
    ],
  });
}
