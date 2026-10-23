import { formatDoctorReport, type DoctorCheck } from "../application/doctor.ts";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  notifyAtHostBoundary,
  registerExtensionCommand,
  synchronousNow,
  type ExtensionSubcommand,
  type JsonObject,
} from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { hasCustomSurface, openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { adaptiveHostRefreshTicker } from "../boundary/host-refresh-ticker.ts";
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
import { SubagentFleetComponent, type FleetMessageDelivery } from "../ui/fleet.ts";
import { subagentUiRefreshCadence } from "../ui/refresh.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { openProfileDashboard } from "./profile-dashboard.ts";
import { subagentSettingsSubcommand } from "./subagent-settings.ts";

interface SessionProfileSetSnapshotWrite extends Omit<
  SubagentCreateProfileSetFromSnapshotPatch,
  "profiles"
> {
  readonly expectedRevision: number;
}

export interface FleetManagerActions {
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

function openFleetManager(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): Promise<void> {
  if (!hasCustomSurface(ctx)) {
    if (ctx.hasUI)
      notifyAtHostBoundary(ctx, "Open Pi in an interactive terminal to use /subagents", "warning");
    return Promise.resolve();
  }
  if (!actions.isAvailable()) {
    notifyAtHostBoundary(
      ctx,
      "Subagents aren't running; run /reload, then reopen /subagents",
      "warning",
    );
    return Promise.resolve();
  }
  const owner = actions.captureModelRefresh();
  const isCurrent = () => owner.isCurrent() && !ctx.signal?.aborted;
  let closeSurface: () => void = Fn.constVoid;
  let dispose: () => void = Fn.constVoid;
  const surface = openOwnedSurface(ctx, {
    closedValue: undefined,
    placement: "screen",
    isCurrent,
    onControl: (close) => {
      closeSurface = close;
    },
    onClose: () => {
      dispose();
    },
    create: ({ tui, theme, keybindings, getHeight, finish }) => {
      let unsubscribe: () => void = Fn.constVoid;
      const manager = new SubagentFleetComponent({
        theme,
        getProjection: bridge.get,
        getHeight,
        getNow: synchronousNow,
        ...fullScreenKeybindingOptions(keybindings),
        requestRender: () => tui.requestRender(),
        close: () => finish(undefined),
        isCurrent,
        onDispose: () => {
          refreshTicker.dispose();
          unsubscribe();
        },
        actions: {
          stop: actions.stop,
          interrupt: actions.interrupt,
          resume: actions.resume,
          // Both modes share the send path, which answers a pending question or steers.
          message: (id, _mode, message, expected) => actions.send(id, message, expected),
          rename: actions.rename,
        },
      });
      const refreshTicker = adaptiveHostRefreshTicker({
        getCadence: () =>
          subagentUiRefreshCadence(bridge.get().runs, { includeTerminalAges: true }),
        startTicker: startHostUiTicker,
        requestRender: () => {
          if (isCurrent()) tui.requestRender();
          else closeSurface();
        },
      });
      dispose = () => manager.dispose();
      unsubscribe = bridge.subscribe(() => {
        if (!isCurrent()) return closeSurface();
        manager.invalidate();
        refreshTicker.sync();
        tui.requestRender();
      });
      return manager;
    },
  }).pipe(Effect.orDie);
  // The command's signal interrupts the surface, closing it even when an idle fleet has no refresh
  // or projection to notice. Retiring the session disposes its runtime, which interrupts the surface
  // as well; the refresh and projection checks above also close it. Both settle the command quietly.
  return owner
    .run(surface, ctx.signal ?? new AbortController().signal)
    .then(Fn.constVoid, (cause: unknown) => {
      if (isCurrent()) throw cause;
    });
}

const profilesSubcommand = (
  pi: ExtensionAPI,
  actions: FleetManagerActions,
): ExtensionSubcommand => ({
  name: "profiles",
  description: "Edit Current Session profiles and saved sets",
  arguments: "[profile]",
  complete: (prefix) => {
    const matches = PROFILE_IDS.filter((profile) => profile.startsWith(prefix.trim())).map(
      (profile) => ({
        value: profile,
        label: profile,
        description: `Edit ${profile} in Current Session`,
      }),
    );
    return matches.length ? matches : null;
  },
  handler: (args, ctx) => {
    const parts = args.trim().split(/\s+/u).filter(Boolean);
    const profile = PROFILE_IDS.find((id) => id === parts[0]);
    if (parts.length === 0 || (parts.length === 1 && profile))
      return openProfileDashboard(pi, ctx, actions, {
        initialProfile: profile ?? PROFILE_IDS[0],
        initialFocus: profile ? "fields" : "profiles",
      });
    notifyAtHostBoundary(ctx, `Usage: /subagents profiles [${PROFILE_IDS.join("|")}]`, "warning");
    return Promise.resolve();
  },
});

const doctorSubcommand = (actions: FleetManagerActions): ExtensionSubcommand => ({
  name: "doctor",
  description: "Check subagent setup and route readiness",
  handler: (_args, ctx) =>
    actions.runDoctor(ctx).then(
      (checks) =>
        notifyAtHostBoundary(
          ctx,
          formatDoctorReport(checks),
          checks.some((item) => item.status !== "ok") ? "warning" : "info",
        ),
      () =>
        notifyAtHostBoundary(
          ctx,
          "Subagents doctor couldn't run; run /reload and try again",
          "error",
        ),
    ),
});

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  registerExtensionCommand(pi, {
    name: "subagents",
    description: "Open the subagent fleet, or edit profiles and settings",
    bare: {
      handler: (_args, ctx) =>
        ctx.mode === "tui" && actions.isAvailable() && actions.openActivity
          ? actions
              .openActivity(ctx.signal)
              .then((opened) => (opened ? undefined : openFleetManager(ctx, bridge, actions)))
          : openFleetManager(ctx, bridge, actions),
    },
    subcommands: [
      profilesSubcommand(pi, actions),
      subagentSettingsSubcommand(actions),
      doctorSubcommand(actions),
    ],
  });
}
