// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import * as Effect from "effect/Effect";
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
import { SubagentConfigStoreError } from "../config/store.ts";
import type {
  SubagentCopyProfileSetPatch,
  SubagentCreateProfileSetFromSnapshotPatch,
  SubagentDefaultProfileSetPatch,
  SubagentDeleteProfileSetPatch,
  SubagentNestingPatch,
  SubagentProfilePatch,
  SubagentRenameProfileSetPatch,
} from "../config/store.ts";
import {
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import {
  type SessionNestingPatch,
  type SessionProfilePatch,
  type SessionProfileSetPatch,
} from "../profiles/session-overrides.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import { subagentUiRefreshCadence } from "../ui/refresh.ts";
import {
  declaredRouteForDraft,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import {
  loadCandidateModelPicker,
  preferredHerdrPiSelector,
  ProfileModelCatalog,
  type ProfileModelCatalogSnapshot,
} from "./profile-model-catalog.ts";
import { createProfileModelChoices } from "./ui/model-picker.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceCloseResult,
  type ProfileWorkspaceOptions,
  type ProfileWorkspaceSaveResult,
} from "./profile-workspace.ts";
import {
  openProfileDashboard,
  profileSetPatchBase,
  isSessionProfileConflict,
  captureProjectWriteTrust,
  type ProfileEditorPosition,
} from "./profile-dashboard.ts";

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

const projectedParentModel = (
  snapshot: ProfileModelCatalogSnapshot,
  parentSelector: string | undefined,
) =>
  parentSelector
    ? snapshot.piModels.find((model) => `${model.provider}/${model.id}` === parentSelector)
    : undefined;

const supportedPiEfforts = (
  candidate: ProfileCandidate,
  snapshot: ProfileModelCatalogSnapshot,
  parentSelector: string | undefined,
): ReadonlyArray<SubagentEffort> | undefined => {
  if (candidate.runtime !== "pi") return undefined;
  const choices = createProfileModelChoices({
    models: snapshot.piModels,
    parentModel: projectedParentModel(snapshot, parentSelector),
    currentSelector: candidate.model,
    allowParent: candidate.host === "local",
  });
  return choices.find((choice) =>
    candidate.model === "parent"
      ? choice.choice.kind === "parent"
      : choice.choice.kind === "model" && choice.choice.selector === candidate.model,
  )?.supportedEfforts;
};

const fastModeAvailable = (
  candidate: ProfileCandidate,
  parentSelector: string | undefined,
): boolean => {
  if (candidate.runtime === "pi" && candidate.model === "parent")
    return parentSelector ? supportsSubagentFastMode("pi", parentSelector) : false;
  return supportsSubagentFastMode(candidate.runtime, candidate.model);
};

function openProfileEditor(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
  target: ProfileWorkspaceTarget,
  position: ProfileEditorPosition,
): Promise<ProfileWorkspaceCloseResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !Predicate.isFunction(ctx.ui.custom)) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "Open Pi in an interactive terminal to change agent profiles with /subagents profiles.",
        "warning",
      );
    return Promise.resolve(false);
  }
  const projectTrusted = isProjectTrusted(ctx);
  if (target.kind === "profile-set" && target.set.scope === "project" && !projectTrusted) {
    ctx.ui.notify("Trust this project to edit its saved profile sets.", "warning");
    return Promise.resolve(false);
  }
  const refreshOwner = actions.captureModelRefresh();
  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      if (!refreshOwner.isCurrent()) return false;
      let inspection = initialInspection;
      const modelCatalog = new ProfileModelCatalog(
        ctx.modelRegistry,
        (ctx.scopedModels ?? []).map(({ model }) => model),
      );
      let requestWorkspaceRender: (() => void) | undefined;
      const modelRefreshController = new AbortController();
      let refreshWarningSent = false;
      void refreshOwner.run(modelCatalog.refresh(), modelRefreshController.signal).then(
        (result) => {
          if (!refreshOwner.isCurrent()) return;
          if (result === "updated" && !modelRefreshController.signal.aborted)
            requestWorkspaceRender?.();
          if (
            result === "failed" &&
            !modelRefreshController.signal.aborted &&
            !refreshWarningSent
          ) {
            refreshWarningSent = true;
            ctx.ui.notify(
              "Could not refresh Pi models. Showing the last available list.",
              "warning",
            );
          }
        },
        () => undefined,
      );
      let parentEffort: SubagentEffort = "high";
      if (ctx.model) {
        try {
          parentEffort = decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";
        } catch {
          // Launch resolution uses the same conservative fallback.
        }
      }
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const refreshInspection = (conflictMessage?: string): Promise<ProfileWorkspaceSaveResult> =>
        actions.inspectProfiles(isProjectTrusted(ctx)).then(
          (next): ProfileWorkspaceSaveResult => {
            inspection = next;
            return conflictMessage ? { inspection, conflictMessage } : { inspection };
          },
          (): ProfileWorkspaceSaveResult => ({
            refreshError:
              "The edit may have been saved, but the editor could not refresh. Close and reopen it.",
          }),
        );
      const saveDraft = (
        editorTarget: ProfileWorkspaceTarget,
        profile: ProfileId,
        draft: ProfileRouteDraft,
      ): Promise<ProfileWorkspaceSaveResult> => {
        const declaration = declaredRouteForDraft(draft);
        if (!declaration.valid) return Promise.reject(new Error(declaration.error));
        if (editorTarget.kind === "session")
          return actions
            .patchSessionProfile({
              profile,
              ...(declaration.route !== undefined && {
                route: normalizeDeclaredProfileRoute(declaration.route),
              }),
              expectedRevision: inspection.session.revision,
            })
            .then(
              () => refreshInspection(),
              (error) => {
                if (isSessionProfileConflict(error))
                  return refreshInspection(
                    "Current Session changed while you were editing. The editor now shows the latest profiles. Try again.",
                  );
                throw error;
              },
            );
        const scope = editorTarget.set.scope;
        const writeTrust = captureProjectWriteTrust(
          ctx,
          scope,
          "This project is no longer trusted. Nothing was saved.",
        );
        if (!writeTrust) return refreshInspection();
        return actions
          .patchProfile({
            ...profileSetPatchBase(inspection, scope, writeTrust.projectTrusted),
            profileSet: editorTarget.set.name,
            profile,
            ...(declaration.route !== undefined && { route: declaration.route }),
          })
          .then(
            () => refreshInspection(),
            (error) => {
              if (
                error instanceof SubagentConfigStoreError &&
                error.operation === "update" &&
                error.message ===
                  "Subagents settings changed on disk; reopen /subagents profiles and try again."
              )
                return refreshInspection(
                  "Saved settings changed on disk. Your change was not applied. The editor now shows the latest profiles. Try again.",
                );
              throw error;
            },
          );
      };
      return ctx.ui
        .custom<ProfileWorkspaceCloseResult>(
          (tui, theme, keybindings, done) => {
            requestWorkspaceRender = () => tui.requestRender();
            const baseOptions: ProfileWorkspaceOptions = {
              theme,
              inspection,
              projectTrusted,
              target,
              ...position,
              parentEffort,
              preferredPiModel: () => preferredHerdrPiSelector(modelCatalog.capture(), parentModel),
              getHeight: () => tui.terminal.rows,
              requestRender: () => tui.requestRender(),
              matchesKeybinding: (data, id) => keybindings.matches(data, id),
              keybindingLabel: (id, fallback) =>
                fullScreenKeybindingLabel(
                  id,
                  fallback,
                  Predicate.isFunction(keybindings.getKeys)
                    ? (key: FullScreenSelectionKeybindingId) => keybindings.getKeys(key)
                    : undefined,
                ),
              close: done,
              saveDraft,
              loadModelPicker: (profile, candidateIndex, candidate, signal) => {
                const baseInput = {
                  profile,
                  candidateIndex,
                  candidate,
                  listNativeModels: actions.listNativeModels,
                  piCatalog: modelCatalog.capture(),
                };
                const withParent = parentModel
                  ? { ...baseInput, parentSelector: parentModel }
                  : baseInput;
                return loadCandidateModelPicker(signal ? { ...withParent, signal } : withParent);
              },
              supportedPiEfforts: (candidate) =>
                supportedPiEfforts(candidate, modelCatalog.capture(), parentModel),
              fastModeAvailable: (candidate) => fastModeAvailable(candidate, parentModel),
              onDispose: () => {
                requestWorkspaceRender = undefined;
                modelRefreshController.abort();
              },
            };
            return new ProfileWorkspaceComponent(
              parentModel ? { ...baseOptions, parentModel } : baseOptions,
            );
          },
          {
            overlay: true,
            overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
          },
        )
        .catch(() => {
          ctx.ui.notify("Could not open Subagents profile settings. Close and try again.", "error");
          return false as const;
        })
        .finally(() => {
          requestWorkspaceRender = undefined;
          modelRefreshController.abort();
        });
    },
    (error) => {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Could not inspect profile settings.",
        "error",
      );
      return false;
    },
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
        return openProfileDashboard(
          ctx,
          actions,
          (target, position) => openProfileEditor(pi, ctx, actions, target, position),
          profile,
        );
      ctx.ui.notify(
        "Usage: /subagents [settings | profiles [profile]]; use a known profile name. Omit arguments for the fleet inspector.",
        "error",
      );
      return Promise.resolve();
    },
  });
}
