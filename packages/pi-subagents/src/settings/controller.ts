// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSettingsArguments, isProjectTrusted, synchronousNow } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import {
  makeAdaptiveHostRefreshTicker,
  type AdaptiveHostRefreshTicker,
} from "../boundary/host-refresh-ticker.ts";
import type { SubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import {
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_SUBAGENT_DEPTH,
  type SubagentNestingPolicy,
  type WriterWorkspaceMode,
} from "../config/schema.ts";
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
import { SubagentFleetComponent } from "../ui/fleet.ts";
import { subagentUiRefreshCadence } from "../ui/refresh.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
import { openProfileDashboard } from "./profile-dashboard.ts";
import { captureProjectWriteTrust, profileSetPatchBase } from "./profile-write-context.ts";
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
  readonly send: (id: string, message: string) => Promise<void>;
  readonly reply: (id: string, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
  readonly inspectProfiles: (projectTrusted: boolean) => Promise<ProfileSettingsInspection>;
  readonly patchProfile: (patch: SubagentProfilePatch) => Promise<void>;
  readonly patchProfileWithReceipt?: (patch: SubagentProfilePatch) => Promise<JsonObject>;
  readonly restoreProfileDeclaration?: (patch: SubagentProfileRestorePatch) => Promise<JsonObject>;
  readonly patchSessionProfileWithReceipt?: (
    patch: SessionProfilePatch,
  ) => Promise<SessionProfileSnapshot>;
  readonly replaceSessionProfilesWithReceipt?: (
    patch: SessionProfileSetPatch,
  ) => Promise<SessionProfileSnapshot>;
  readonly patchDefaultProfileSet: (patch: SubagentDefaultProfileSetPatch) => Promise<void>;
  readonly createProfileSetFromSnapshot: (patch: SessionProfileSetSnapshotWrite) => Promise<void>;
  readonly copyProfileSet: (patch: SubagentCopyProfileSetPatch) => Promise<void>;
  readonly renameProfileSet: (patch: SubagentRenameProfileSetPatch) => Promise<void>;
  readonly deleteProfileSet: (patch: SubagentDeleteProfileSetPatch) => Promise<void>;
  readonly patchNesting: (patch: SubagentNestingPatch) => Promise<void>;
  readonly inspectWriterWorkspace: () => Promise<{
    readonly mode: WriterWorkspaceMode;
    readonly blockedReason?: string;
  }>;
  /** The coordinator rejects unsafe switches and persists accepted preferences for new sessions. */
  readonly setWriterWorkspaceMode: (mode: WriterWorkspaceMode) => Promise<void>;
  readonly patchSessionProfile: (patch: SessionProfilePatch) => Promise<void>;
  readonly replaceSessionProfiles: (patch: SessionProfileSetPatch) => Promise<void>;
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
      ctx.ui.notify(
        "Open Pi in an interactive terminal to view agents with /subagents.",
        "warning",
      );
    return Promise.resolve();
  }
  if (!actions.isAvailable()) {
    ctx.ui.notify("Subagents are not active. Run /reload, then reopen /subagents.", "warning");
    return Promise.resolve();
  }
  return ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      let unsubscribe = () => {};
      const manager = new SubagentFleetComponent({
        theme,
        getProjection: bridge.get,
        getHeight: () => tui.terminal.rows,
        getNow: synchronousNow,
        matchesKeybinding: (data, id) => keybindings.matches(data, id),
        keybindingLabel: (id, fallback) =>
          fullScreenKeybindingLabel(
            id,
            fallback,
            Predicate.isFunction(keybindings.getKeys)
              ? (key: FullScreenSelectionKeybindingId) => keybindings.getKeys(key)
              : undefined,
          ),
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        actions: {
          stop: actions.stop,
          interrupt: actions.interrupt,
          resume: actions.resume,
          message: (id, mode, message) =>
            mode === "reply" ? actions.reply(id, message) : actions.send(id, message),
          rename: actions.rename,
        },
      });
      let refreshTicker: AdaptiveHostRefreshTicker | undefined;
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
      return {
        get focused() {
          return manager.focused;
        },
        set focused(value: boolean) {
          manager.focused = value;
        },
        render: (width) => manager.render(width),
        handleInput: (data) => manager.handleInput(data),
        invalidate: () => manager.invalidate(),
        dispose: () => {
          refreshTicker?.dispose();
          unsubscribe();
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
  );
}

const boundedInteger = (value: string, minimum: number, maximum: number): number | undefined => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
};

function openNestingSettings(
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
): Promise<void> {
  if (!ctx.hasUI) return Promise.resolve();
  const trusted = isProjectTrusted(ctx);
  return actions.inspectProfiles(trusted).then((inspection) =>
    ctx.ui
      .select(
        "Apply nesting limits to",
        trusted ? ["Session", "Global", "Project"] : ["Session", "Global"],
      )
      .then((selectedScope) => {
        if (!selectedScope) return;
        const normalizedScope = selectedScope.toLowerCase();
        if (
          normalizedScope !== "session" &&
          normalizedScope !== "global" &&
          normalizedScope !== "project"
        )
          return;
        const scope = normalizedScope;
        const current: SubagentNestingPolicy =
          scope === "session"
            ? (inspection.session.nesting ?? inspection.session.effectiveConfig.nesting)
            : scope === "project"
              ? (inspection.project?.file.nesting ?? inspection.config.nesting)
              : (inspection.global.file.nesting ?? inspection.config.nesting);
        const saveNesting = (nesting?: SubagentNestingPolicy): Promise<void> | undefined => {
          const patch = nesting ? { nesting } : {};
          if (scope === "session")
            return actions.patchSessionNesting({
              expectedRevision: inspection.session.revision,
              ...patch,
            });
          const writeTrust = captureProjectWriteTrust(
            ctx,
            scope,
            "This project is no longer trusted. Nesting limits were not saved.",
          );
          if (!writeTrust) return;
          return actions
            .patchNesting({
              ...profileSetPatchBase(inspection, scope, writeTrust.projectTrusted),
              ...patch,
            })
            .then(() => ctx.ui.notify("Nesting limits saved. Run /reload to apply them.", "info"));
        };
        return ctx.ui
          .select("Choose nesting limits", ["Set limits", "Inherit limits"])
          .then((choice) => {
            if (!choice) return;
            if (choice.startsWith("Inherit")) return saveNesting();
            return ctx.ui
              .input(
                `Maximum direct children (${MIN_DIRECT_CHILDREN} to ${MAX_DIRECT_CHILDREN})`,
                current.maxDirectChildren.toString(),
              )
              .then((directText) => {
                if (directText === undefined) return;
                const maxDirectChildren = boundedInteger(
                  directText,
                  MIN_DIRECT_CHILDREN,
                  MAX_DIRECT_CHILDREN,
                );
                if (maxDirectChildren === undefined) {
                  ctx.ui.notify(
                    `Maximum direct children must be a whole number from ${MIN_DIRECT_CHILDREN} to ${MAX_DIRECT_CHILDREN}.`,
                    "error",
                  );
                  return;
                }
                return ctx.ui
                  .input(
                    `Maximum depth (${MIN_SUBAGENT_DEPTH} to ${MAX_SUBAGENT_DEPTH})`,
                    current.maxDepth.toString(),
                  )
                  .then((depthText) => {
                    if (depthText === undefined) return;
                    const maxDepth = boundedInteger(
                      depthText,
                      MIN_SUBAGENT_DEPTH,
                      MAX_SUBAGENT_DEPTH,
                    );
                    if (maxDepth === undefined) {
                      ctx.ui.notify(
                        `Maximum depth must be a whole number from ${MIN_SUBAGENT_DEPTH} to ${MAX_SUBAGENT_DEPTH}.`,
                        "error",
                      );
                      return;
                    }
                    return saveNesting({ maxDirectChildren, maxDepth });
                  });
              });
          });
      }),
  );
}

function openWriterWorkspaceSettings(
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
): Promise<void> {
  const owner = actions.captureModelRefresh();
  return actions
    .inspectWriterWorkspace()
    .then((snapshot) => {
      if (!owner.isCurrent() || !actions.isAvailable()) return;
      if (snapshot.blockedReason) {
        ctx.ui.notify(snapshot.blockedReason, "warning");
        return;
      }
      const labels =
        snapshot.mode === "worktree"
          ? ["Worktree", "Shared checkout"]
          : ["Shared checkout", "Worktree"];
      return ctx.ui.select("Writer workspace", labels).then((choice) => {
        if (!owner.isCurrent() || !actions.isAvailable()) return;
        const mode =
          choice === "Worktree"
            ? "worktree"
            : choice === "Shared checkout"
              ? "shared-checkout"
              : undefined;
        if (mode === undefined || mode === snapshot.mode) return;
        return actions.setWriterWorkspaceMode(mode).then(() => {
          if (owner.isCurrent())
            ctx.ui.notify("Writer workspace updated and saved for new sessions.", "info");
        });
      });
    })
    .catch((error) => {
      if (owner.isCurrent())
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not change writer workspace.",
          "error",
        );
    });
}

function openSubagentSettings(
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
): Promise<void> {
  if (!ctx.hasUI || !actions.isAvailable()) return Promise.resolve();
  const owner = actions.captureModelRefresh();
  return ctx.ui
    .select("Subagents settings", ["Writer workspace", "Nesting limits"])
    .then((choice) => {
      if (!owner.isCurrent() || !actions.isAvailable()) return;
      if (choice === "Writer workspace") return openWriterWorkspaceSettings(ctx, actions);
      if (choice === "Nesting limits") return openNestingSettings(ctx, actions);
      return;
    });
}

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  pi.registerCommand("subagents", {
    description: "Open the subagent fleet or configure profiles",
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
        { id: "settings", description: "Configure writer workspace and nesting limits" },
      ]);
    },
    handler: (args, ctx) => {
      const command = args.trim();
      if (!command) return openFleetManager(ctx, bridge, actions);
      if (command === "settings") return openSubagentSettings(ctx, actions);
      const parts = command.split(/\s+/u);
      const profile = PROFILE_IDS.find((id) => id === parts[1]);
      if (parts[0] === "profiles" && (parts.length === 1 || (parts.length === 2 && profile)))
        return openProfileDashboard(pi, ctx, actions, {
          initialProfile: profile ?? PROFILE_IDS[0],
          initialFocus: profile ? "fields" : "profiles",
        }).then(() => undefined);
      ctx.ui.notify(
        "Usage: /subagents [settings | profiles [profile]]; use a known profile name. Omit arguments for the fleet inspector.",
        "error",
      );
      return Promise.resolve();
    },
  });
}
