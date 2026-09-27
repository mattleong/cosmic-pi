// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSettingsArguments, notifyAtHostBoundary, synchronousNow } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import {
  makeAdaptiveHostRefreshTicker,
  type AdaptiveHostRefreshTicker,
} from "../boundary/host-refresh-ticker.ts";
import type { SubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { WriterWorkspaceInspection } from "../run/workspace-control.ts";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type {
  SubagentCopyProfileSetPatch,
  SubagentCreateProfileSetFromSnapshotPatch,
  SubagentDefaultProfileSetPatch,
  SubagentDeleteProfileSetPatch,
  SubagentNestingPatch,
  SubagentProfilePatch,
  SubagentRenameProfileSetPatch,
} from "../config/store.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import {
  type SessionNestingPatch,
  type SessionProfilePatch,
  type SessionProfileSetPatch,
} from "../profiles/session-overrides.ts";
import { SubagentFleetComponent, type FleetMessageDelivery } from "../ui/fleet.ts";
import { subagentUiRefreshCadence } from "../ui/refresh.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { openProfileDashboard } from "./profile-dashboard.ts";
import type { JsonObject } from "pi-cosmic-core";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import type { SubagentProfileRestorePatch } from "../config/store.ts";

export interface SessionProfileSetSnapshotWrite extends Omit<
  SubagentCreateProfileSetFromSnapshotPatch,
  "profiles"
> {
  readonly expectedRevision: number;
}

export interface FleetManagerActions {
  readonly isAvailable: () => boolean;
  readonly captureModelRefresh: () => {
    readonly isCurrent: () => boolean;
    readonly run: <A>(effect: Effect.Effect<A>, signal: AbortSignal) => Promise<A>;
  };
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  /** Pending native delivery resolves as `pending`; every other typed failure still rejects. */
  readonly send: (id: string, message: string) => Promise<FleetMessageDelivery>;
  readonly reply: (id: string, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
  readonly inspectProfiles: (projectTrusted: boolean) => Promise<ProfileSettingsInspection>;
  readonly patchProfile: (patch: SubagentProfilePatch) => Promise<JsonObject>;
  readonly restoreProfileDeclaration: (patch: SubagentProfileRestorePatch) => Promise<JsonObject>;
  readonly patchDefaultProfileSet: (patch: SubagentDefaultProfileSetPatch) => Promise<void>;
  readonly createProfileSetFromSnapshot: (patch: SessionProfileSetSnapshotWrite) => Promise<void>;
  readonly copyProfileSet: (patch: SubagentCopyProfileSetPatch) => Promise<void>;
  readonly renameProfileSet: (patch: SubagentRenameProfileSetPatch) => Promise<void>;
  readonly deleteProfileSet: (patch: SubagentDeleteProfileSetPatch) => Promise<void>;
  readonly patchNesting: (patch: SubagentNestingPatch) => Promise<void>;
  readonly inspectWriterWorkspace: () => Promise<WriterWorkspaceInspection>;
  /** The coordinator rejects unsafe switches and persists accepted preferences for new sessions. */
  readonly setWriterWorkspaceMode: (mode: WriterWorkspaceMode) => Promise<void>;
  readonly patchSessionProfile: (patch: SessionProfilePatch) => Promise<SessionProfileSnapshot>;
  readonly replaceSessionProfiles: (
    patch: SessionProfileSetPatch,
  ) => Promise<SessionProfileSnapshot>;
  readonly patchSessionNesting: (patch: SessionNestingPatch) => Promise<void>;
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
  if (ctx.mode !== "tui" || !Predicate.isFunction(ctx.ui.custom)) {
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
  return openOwnedSurfacePromise<undefined>(ctx, {
    placement: "screen",
    closedValue: undefined,
    create: ({ tui, theme, keybindings, getHeight, finish }) => {
      let unsubscribe = () => {};
      let refreshTicker: AdaptiveHostRefreshTicker | undefined;
      const manager = new SubagentFleetComponent({
        theme,
        getProjection: bridge.get,
        getHeight,
        getNow: synchronousNow,
        ...fullScreenKeybindingOptions(keybindings),
        requestRender: () => tui.requestRender(),
        close: () => finish(undefined),
        onDispose: () => {
          refreshTicker?.dispose();
          unsubscribe();
        },
        actions: {
          stop: actions.stop,
          interrupt: actions.interrupt,
          resume: actions.resume,
          message: (id, mode, message) =>
            mode === "reply"
              ? actions.reply(id, message).then(() => "delivered" as const)
              : actions.send(id, message),
          rename: actions.rename,
        },
      });
      unsubscribe = bridge.subscribe(() => {
        manager.invalidate();
        refreshTicker?.sync();
        tui.requestRender();
      });
      refreshTicker = makeAdaptiveHostRefreshTicker({
        getCadence: () =>
          subagentUiRefreshCadence(bridge.get().runs, { includeTerminalAges: true }),
        startTicker: startHostUiTicker,
        requestRender: () => tui.requestRender(),
      });
      return manager;
    },
  }).then((outcome) => {
    // A failed opening rejects the command, as Pi's own custom Promise does.
    if (outcome._tag === "Failed") throw outcome.cause;
  });
}

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  pi.registerCommand("subagents", {
    description: "Open the subagent fleet, or edit profiles with /subagents profiles",
    getArgumentCompletions: (prefix) => {
      const profilePrefix = /^profiles\s+([^\s]*)$/u.exec(prefix.trimStart());
      if (profilePrefix) {
        const matches = PROFILE_IDS.filter((profile) =>
          profile.startsWith(profilePrefix[1] ?? ""),
        ).map((profile) => ({
          value: `profiles ${profile}`,
          label: profile,
          description: `Edit ${profile} in Current Session`,
        }));
        return matches.length ? matches : null;
      }
      return completeSettingsArguments(prefix, [
        { id: "profiles", description: "Edit Current Session profiles and saved sets" },
      ]);
    },
    handler: (args, ctx) => {
      const command = args.trim();
      if (!command) return openFleetManager(ctx, bridge, actions);
      const parts = command.split(/\s+/u);
      const profile = PROFILE_IDS.find((id) => id === parts[1]);
      if (parts[0] === "profiles" && (parts.length === 1 || (parts.length === 2 && profile)))
        return openProfileDashboard(pi, ctx, actions, {
          initialProfile: profile ?? PROFILE_IDS[0],
          initialFocus: profile ? "fields" : "profiles",
        });
      notifyAtHostBoundary(
        ctx,
        "Usage: /subagents [profiles [profile]]; settings are in /subagents-settings",
        "warning",
      );
      return Promise.resolve();
    },
  });
}
