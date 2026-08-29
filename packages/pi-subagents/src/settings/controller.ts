// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import * as Predicate from "effect/Predicate";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  completeSettingsArguments,
  hasObjectRuntimeType,
  isProjectTrusted,
  synchronousNow,
} from "pi-cosmic-core";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import {
  makeAdaptiveHostRefreshTicker,
  type AdaptiveHostRefreshTicker,
} from "../boundary/host-refresh-ticker.ts";
import { startHostUiTicker, type SubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import {
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_SUBAGENT_DEPTH,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import type {
  SubagentCopyProfileSetPatch,
  SubagentCreateProfileSetPatch,
  SubagentDefaultProfileSetPatch,
  SubagentDeleteProfileSetPatch,
  SubagentNestingPatch,
  SubagentProfilePatch,
  SubagentRenameProfileSetPatch,
} from "../config/store.ts";
import { normalizeProfileSetName } from "../config/schema.ts";
import {
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  sameProfileCandidates,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import {
  SessionProfileConflictError,
  type SessionNestingPatch,
  type SessionProfilePatch,
} from "../profiles/session-overrides.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import { isActiveRunState } from "../run/model.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import { subagentUiRefreshCadence } from "../ui/refresh.ts";
import {
  declaredRouteForDraft,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
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
import { ProfileSetPickerComponent, type ProfileSetPickerAction } from "./profile-set-picker.ts";

export interface FleetManagerActions {
  readonly isAvailable: () => boolean;
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  readonly send: (id: string, message: string) => Promise<void>;
  readonly reply: (id: string, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
  readonly inspectProfiles: (projectTrusted: boolean) => Promise<ProfileSettingsInspection>;
  readonly patchProfile: (patch: SubagentProfilePatch) => Promise<void>;
  readonly patchDefaultProfileSet: (patch: SubagentDefaultProfileSetPatch) => Promise<void>;
  readonly createProfileSet: (patch: SubagentCreateProfileSetPatch) => Promise<void>;
  readonly copyProfileSet: (patch: SubagentCopyProfileSetPatch) => Promise<void>;
  readonly renameProfileSet: (patch: SubagentRenameProfileSetPatch) => Promise<void>;
  readonly deleteProfileSet: (patch: SubagentDeleteProfileSetPatch) => Promise<void>;
  readonly patchNesting: (patch: SubagentNestingPatch) => Promise<void>;
  readonly patchSessionProfile: (patch: SessionProfilePatch) => Promise<void>;
  readonly patchSessionNesting: (patch: SessionNestingPatch) => Promise<void>;
  readonly clearSessionProfiles: (expectedRevision: number) => Promise<void>;
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
    if (ctx.hasUI) ctx.ui.notify("/subagents requires interactive TUI mode.", "warning");
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

const persistentProfilesDifferFromSessionBase = (
  inspection: ProfileSettingsInspection,
): boolean => {
  const savedSelection = inspection.config.currentProfileSet;
  const activeSelection = inspection.session.baseConfig.currentProfileSet;
  if (
    savedSelection.scope !== activeSelection.scope ||
    savedSelection.invalid !== activeSelection.invalid ||
    (savedSelection.scope !== "builtin" &&
      activeSelection.scope !== "builtin" &&
      savedSelection.name !== activeSelection.name)
  )
    return true;
  return PROFILE_IDS.some(
    (profile) =>
      inspection.config.profileSources[profile] !==
        inspection.session.baseConfig.profileSources[profile] ||
      !sameProfileCandidates(
        inspection.config.profiles[profile].candidates,
        inspection.session.baseConfig.profiles[profile].candidates,
      ),
  );
};

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

function requestProfileReload(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
): Promise<boolean> {
  const active = bridge.get().runs.some((run) => isActiveRunState(run.state));
  return ctx.ui
    .confirm(
      "Reload profile settings now?",
      active
        ? "Active subagent runs exist. Reloading stops all session-scoped runs. Continue?"
        : "Reload now to apply the saved profile routes?",
    )
    .then((reload) => {
      if (!reload) return false;
      return Promise.resolve(ctx.reload()).then(() => true);
    });
}

function openProfileEditor(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  target: ProfileWorkspaceTarget,
  initialProfile: ProfileId = "generalist",
  initialReloadRequired = false,
): Promise<ProfileWorkspaceCloseResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !Predicate.isFunction(ctx.ui.custom)) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "/subagents profiles requires interactive TUI mode; edit pi-subagents.json and run /reload.",
        "warning",
      );
    return Promise.resolve(false);
  }
  const projectTrusted = isProjectTrusted(ctx);
  if (target.kind === "profile-set" && target.set.scope === "project" && !projectTrusted) {
    ctx.ui.notify("Project profile settings require a trusted project.", "warning");
    return Promise.resolve(false);
  }
  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      let inspection: ProfileSettingsInspection = initialInspection;
      const modelCatalog = new ProfileModelCatalog(ctx.modelRegistry);
      let requestWorkspaceRender: (() => void) | undefined;
      let modelRefreshNotified = false;
      const modelRefreshController = new AbortController();
      const notifyModelRefreshFailure = (): void => {
        if (modelRefreshNotified || modelRefreshController.signal.aborted) return;
        modelRefreshNotified = true;
        ctx.ui.notify(
          "Could not refresh Pi model catalogs; showing the last coherent snapshot.",
          "warning",
        );
      };
      void modelCatalog.refresh(modelRefreshController.signal).then((result) => {
        if (result === "failed") notifyModelRefreshFailure();
        else if (result === "updated" && !modelRefreshController.signal.aborted)
          requestWorkspaceRender?.();
      });
      let parentEffort: SubagentEffort = "high";
      if (ctx.model) {
        try {
          parentEffort = decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";
        } catch {
          // Host callback failures use the same conservative fallback as launch resolution.
        }
      }
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const refreshInspection = (conflictMessage?: string): Promise<ProfileWorkspaceSaveResult> =>
        actions.inspectProfiles(isProjectTrusted(ctx)).then(
          (nextInspection): ProfileWorkspaceSaveResult => {
            inspection = nextInspection;
            return conflictMessage ? { inspection, conflictMessage } : { inspection };
          },
          (): ProfileWorkspaceSaveResult => ({
            refreshError:
              "Profile settings changed, but the workspace could not refresh. Reopen /subagents profiles before editing again.",
          }),
        );
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const isSessionProfileConflict = <ErrorInput>(error: ErrorInput): boolean =>
        error instanceof SessionProfileConflictError ||
        (hasObjectRuntimeType(error) &&
          error !== null &&
          (error as { readonly _tag?: unknown })._tag === "SessionProfileConflictError");
      const saveDraft = (
        editorTarget: ProfileWorkspaceTarget,
        profile: ProfileId,
        draft: ProfileRouteDraft,
      ): Promise<ProfileWorkspaceSaveResult> => {
        const declaration = declaredRouteForDraft(draft);
        if (!declaration.valid) return Promise.reject(new Error(declaration.error));
        if (editorTarget.kind === "session") {
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
                    "Session profile settings changed concurrently; refreshed the active routes. Retry your edit.",
                  );
                throw error;
              },
            );
        }
        const scope = editorTarget.set.scope;
        const expectedDocument =
          scope === "global" ? inspection.globalDocument : inspection.projectDocument;
        return actions
          .patchProfile({
            scope,
            profileSet: editorTarget.set.name,
            profile,
            ...(declaration.route !== undefined && { route: declaration.route }),
            expectedExists: expectedDocument !== undefined,
            ...(expectedDocument !== undefined && { expectedDocument }),
            projectTrusted: isProjectTrusted(ctx),
          })
          .then(() => refreshInspection());
      };
      const clearSessionOverrides = (): Promise<ProfileWorkspaceSaveResult> =>
        actions.clearSessionProfiles(inspection.session.revision).then(
          () => refreshInspection(),
          (error) => {
            if (isSessionProfileConflict(error))
              return refreshInspection(
                "Session profile settings changed concurrently; refreshed the active routes. Retry clearing them.",
              );
            throw error;
          },
        );
      return ctx.ui
        .custom<ProfileWorkspaceCloseResult>(
          (tui, theme, keybindings, done) => {
            requestWorkspaceRender = () => tui.requestRender();
            const baseOptions: ProfileWorkspaceOptions = {
              theme,
              inspection,
              projectTrusted,
              target,
              initialProfile,
              initialReloadRequired:
                initialReloadRequired || persistentProfilesDifferFromSessionBase(initialInspection),
              parentEffort,
              preferredPiModel: () => preferredHerdrPiSelector(modelCatalog.capture(), parentModel),
              getHeight: () => tui.terminal.rows,
              requestRender: () => tui.requestRender(),
              matchesKeybinding: (data: string, id: FullScreenSelectionKeybindingId) =>
                keybindings.matches(data, id),
              keybindingLabel: (id: FullScreenSelectionKeybindingId, fallback: string) =>
                fullScreenKeybindingLabel(
                  id,
                  fallback,
                  Predicate.isFunction(keybindings.getKeys)
                    ? (key: FullScreenSelectionKeybindingId) => keybindings.getKeys(key)
                    : undefined,
                ),
              close: done,
              saveDraft,
              clearSessionOverrides,
              loadModelPicker: (
                profile: ProfileId,
                candidateIndex: number,
                candidate: ProfileCandidate,
                signal?: AbortSignal,
              ) => {
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
              supportedPiEfforts: (candidate: ProfileCandidate) =>
                supportedPiEfforts(candidate, modelCatalog.capture(), parentModel),
              fastModeAvailable: (candidate: ProfileCandidate) =>
                fastModeAvailable(candidate, parentModel),
              reload: () => requestProfileReload(ctx, bridge),
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
          ctx.ui.notify(
            "Could not open Subagents profile settings. Run /reload and try again; inspect the Pi logs if the problem continues.",
            "error",
          );
          return false;
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

const profileSetPatchBase = (
  inspection: ProfileSettingsInspection,
  scope: "global" | "project",
  projectTrusted: boolean,
) => {
  const expectedDocument =
    scope === "global" ? inspection.globalDocument : inspection.projectDocument;
  return {
    scope,
    expectedExists: expectedDocument !== undefined,
    ...(expectedDocument !== undefined && { expectedDocument }),
    projectTrusted,
  };
};

type ProfileWorkspaceScopeResult = Extract<
  ProfileWorkspaceCloseResult,
  { readonly action: "scope" }
>;

type PersistentProfileSettingsResult = boolean | "reloaded" | ProfileWorkspaceScopeResult;

function openPersistentProfileSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  preferredScope: "global" | "project" = "global",
  initialReloadRequired = false,
): Promise<PersistentProfileSettingsResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !Predicate.isFunction(ctx.ui.custom)) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "/subagents profiles requires interactive TUI mode; edit pi-subagents.json and run /reload.",
        "warning",
      );
    return Promise.resolve(initialReloadRequired);
  }
  let projectTrusted = isProjectTrusted(ctx);
  const initialScope = preferredScope === "project" && !projectTrusted ? "global" : preferredScope;
  if (initialScope !== preferredScope)
    ctx.ui.notify(
      "Project profile settings require a trusted project; opened Global sets.",
      "warning",
    );

  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      let inspection = initialInspection;
      let reloadRequired =
        initialReloadRequired || persistentProfilesDifferFromSessionBase(initialInspection);
      const refresh = (): Promise<void> => {
        const trusted = isProjectTrusted(ctx);
        return actions.inspectProfiles(trusted).then((nextInspection) => {
          projectTrusted = trusted;
          inspection = nextInspection;
        });
      };
      const patchDefault = (
        scope: "global" | "project",
        defaultProfileSet?: string,
      ): Promise<void> => {
        const decoded = scope === "global" ? inspection.global : inspection.project;
        if (
          decoded &&
          !decoded.invalidDefaultProfileSet &&
          decoded.file.defaultProfileSet === defaultProfileSet
        )
          return Promise.resolve();
        return actions
          .patchDefaultProfileSet({
            ...profileSetPatchBase(inspection, scope, isProjectTrusted(ctx)),
            ...(defaultProfileSet !== undefined && { defaultProfileSet }),
          })
          .then(() => {
            reloadRequired = true;
            return refresh();
          });
      };
      const promptName = (title: string, initial = ""): Promise<string | undefined> =>
        ctx.ui.input(title, initial).then((value) => {
          if (value === undefined) return undefined;
          const normalized = normalizeProfileSetName(value);
          if (normalized) return normalized;
          ctx.ui.notify(
            "Profile-set names must be 1-64 characters, start and end with a letter or number, and use only letters, numbers, spaces, dot, underscore, or hyphen.",
            "error",
          );
          return undefined;
        });
      const showPicker = (): Promise<ProfileSetPickerAction | undefined> =>
        ctx.ui.custom<ProfileSetPickerAction | undefined>(
          (tui, theme, keybindings, done) =>
            new ProfileSetPickerComponent({
              theme,
              inspection,
              projectTrusted,
              initialScope,
              reloadRequired,
              getHeight: () => tui.terminal.rows,
              requestRender: () => tui.requestRender(),
              matchesKeybinding: (data, id) => keybindings.matches(data, id),
              close: done,
            }),
          {
            overlay: true,
            overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
          },
        );
      const afterMutation = (operation: Promise<void>): Promise<void> =>
        operation.then(() => {
          reloadRequired = true;
          return refresh();
        });
      const useEntry = (
        entry: Extract<ProfileSetPickerAction, { readonly action: "use" }>["entry"],
      ): Promise<void> => {
        if (entry.kind === "inherit-project") return patchDefault("project");
        if (entry.kind === "set" && entry.scope === "project")
          return patchDefault("project", entry.ref.name);
        const globalDefault = entry.kind === "set" ? entry.ref.name : undefined;
        const project = inspection.project;
        const projectDefaultConfigured = Boolean(
          project &&
          (project.file.defaultProfileSet !== undefined || project.invalidDefaultProfileSet),
        );
        const selectGlobal = (): Promise<void> =>
          inspection.global.file.defaultProfileSet === globalDefault &&
          !inspection.global.invalidDefaultProfileSet
            ? Promise.resolve()
            : patchDefault("global", globalDefault);
        if (!projectDefaultConfigured) return selectGlobal();
        const projectLabel = project?.file.defaultProfileSet
          ? `[P] ${project.file.defaultProfileSet}`
          : "the invalid project default";
        return ctx.ui
          .confirm(
            "Use a global profile set?",
            `This project will stop using ${projectLabel} and inherit the selected global default. Other inheriting projects also use the global default after reload.`,
          )
          .then((confirmed) => {
            if (!confirmed) return undefined;
            return patchDefault("project").then(selectGlobal);
          });
      };
      const afterEditor = (
        editorResult: ProfileWorkspaceCloseResult,
      ): Promise<"continue" | "reloaded" | ProfileWorkspaceScopeResult> => {
        if (editorResult === "reloaded") return Promise.resolve("reloaded");
        reloadRequired =
          (Predicate.isBoolean(editorResult) ? editorResult : editorResult.reloadRequired) ||
          reloadRequired;
        if (!Predicate.isBoolean(editorResult) && editorResult.action === "scope")
          return Promise.resolve({ ...editorResult, reloadRequired });
        return refresh().then(() => "continue");
      };
      const handleAction = (
        action: ProfileSetPickerAction,
      ): Promise<"continue" | "reloaded" | ProfileWorkspaceScopeResult> => {
        if (action.action === "reload")
          return requestProfileReload(ctx, bridge).then((reloaded) =>
            reloaded ? "reloaded" : "continue",
          );
        if (action.action === "edit")
          return openProfileEditor(
            pi,
            ctx,
            bridge,
            actions,
            { kind: "profile-set", set: action.target },
            "generalist",
            reloadRequired,
          ).then(afterEditor);
        if (action.action === "create")
          return promptName(`New ${action.scope} profile-set name`).then((name) => {
            if (!name) return "continue" as const;
            return afterMutation(
              actions.createProfileSet({
                ...profileSetPatchBase(inspection, action.scope, isProjectTrusted(ctx)),
                profileSet: name,
              }),
            )
              .then(() =>
                openProfileEditor(
                  pi,
                  ctx,
                  bridge,
                  actions,
                  { kind: "profile-set", set: { scope: action.scope, name } },
                  "generalist",
                  reloadRequired,
                ),
              )
              .then(afterEditor);
          });
        if (action.action === "copy")
          return promptName(
            `Copy ${action.source.scope} profile set as`,
            `${action.source.name} copy`,
          ).then((name) => {
            if (!name) return "continue" as const;
            return afterMutation(
              actions.copyProfileSet({
                ...profileSetPatchBase(inspection, action.source.scope, isProjectTrusted(ctx)),
                sourceProfileSet: action.source.name,
                profileSet: name,
              }),
            ).then(() => "continue" as const);
          });
        if (action.action === "rename")
          return promptName("Rename profile set", action.target.name).then((name) => {
            if (!name) return "continue" as const;
            return afterMutation(
              actions.renameProfileSet({
                ...profileSetPatchBase(inspection, action.target.scope, isProjectTrusted(ctx)),
                profileSet: action.target.name,
                nextProfileSet: name,
              }),
            ).then(() => "continue" as const);
          });
        if (action.action === "delete")
          return afterMutation(
            actions.deleteProfileSet({
              ...profileSetPatchBase(inspection, action.target.scope, isProjectTrusted(ctx)),
              profileSet: action.target.name,
            }),
          ).then(() => "continue" as const);
        return useEntry(action.entry).then(() => "continue" as const);
      };
      const loop = (): Promise<"reloaded" | ProfileWorkspaceScopeResult | undefined> =>
        showPicker().then((action) => {
          if (!action) return undefined;
          return handleAction(action).then(
            (result) => (result === "continue" ? loop() : result),
            (error) => {
              ctx.ui.notify(
                error instanceof Error ? error.message : "Could not update profile sets.",
                "error",
              );
              return refresh().then(loop, () => undefined);
            },
          );
        });
      return loop().then((result) => {
        if (result === "reloaded") return result;
        if (result) return { ...result, reloadRequired: result.reloadRequired || reloadRequired };
        if (reloadRequired)
          ctx.ui.notify(
            "Profile changes are saved. Run /reload to apply them to new subagents.",
            "info",
          );
        return reloadRequired;
      });
    },
    (error) => {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Could not inspect profile settings.",
        "error",
      );
      return initialReloadRequired;
    },
  );
}

const editableDefaultProfileTarget = (
  inspection: ProfileSettingsInspection,
  scope: "global" | "project",
): ProfileWorkspaceTarget | undefined => {
  const decoded = scope === "global" ? inspection.global : inspection.project;
  const name = decoded?.file.defaultProfileSet;
  if (
    !decoded ||
    !name ||
    decoded.invalidDefaultProfileSet ||
    decoded.invalidProfileSets.includes(name) ||
    !Object.prototype.hasOwnProperty.call(decoded.file.profileSets ?? {}, name)
  )
    return undefined;
  return { kind: "profile-set", set: { scope, name } };
};

function openProfileDashboard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  initialScope: ProfileSettingsScope = "session",
): Promise<void> {
  let target: ProfileWorkspaceTarget = { kind: "session" };
  let scope: ProfileSettingsScope = "session";
  let profile: ProfileId = "generalist";
  let reloadRequired = false;

  const inspectTarget = (
    requestedScope: "global" | "project",
  ): Promise<ProfileWorkspaceTarget | undefined> => {
    const trusted = isProjectTrusted(ctx);
    if (requestedScope === "project" && !trusted) {
      ctx.ui.notify("Project profile settings require a trusted project.", "warning");
      return Promise.resolve(undefined);
    }
    return actions.inspectProfiles(trusted).then(
      (inspection) => editableDefaultProfileTarget(inspection, requestedScope),
      (error) => {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not inspect profile settings.",
          "error",
        );
        return undefined;
      },
    );
  };
  const openSets = (
    preferredScope: "global" | "project",
  ): Promise<"reloaded" | ProfileWorkspaceScopeResult | undefined> =>
    openPersistentProfileSettings(pi, ctx, bridge, actions, preferredScope, reloadRequired).then(
      (result) => {
        if (result === "reloaded") return result;
        if (Predicate.isBoolean(result)) {
          reloadRequired = result || reloadRequired;
          return undefined;
        }
        profile = result.profile;
        reloadRequired = result.reloadRequired || reloadRequired;
        return { ...result, reloadRequired };
      },
    );
  const requestScope = (
    requestedScope: ProfileSettingsScope,
  ): Promise<"reloaded" | "unresolved" | undefined> => {
    if (requestedScope === "session") {
      target = { kind: "session" };
      scope = "session";
      return Promise.resolve(undefined);
    }
    return inspectTarget(requestedScope).then((nextTarget) => {
      if (nextTarget) {
        target = nextTarget;
        scope = requestedScope;
        return undefined;
      }
      if (requestedScope === "project" && !isProjectTrusted(ctx)) return undefined;
      ctx.ui.notify(
        requestedScope === "global"
          ? "Global is using built-in profile routes. Choose or create a Global default set before editing it."
          : "Project is inheriting profile routes or has no editable default set. Choose or create a Project default set before editing it.",
        "warning",
      );
      return openSets(requestedScope).then((setsResult) => {
        if (setsResult === "reloaded") return setsResult;
        if (setsResult) return requestScope(setsResult.scope);
        return inspectTarget(requestedScope).then((selectedTarget) => {
          if (!selectedTarget) return "unresolved" as const;
          target = selectedTarget;
          scope = requestedScope;
          return undefined;
        });
      });
    });
  };
  const restoreCurrentTarget = (): Promise<void> => {
    if (scope === "session") return Promise.resolve();
    return inspectTarget(scope).then((nextTarget) => {
      if (nextTarget) {
        target = nextTarget;
        return;
      }
      target = { kind: "session" };
      scope = "session";
      ctx.ui.notify(
        "The prior persistent profile dashboard is no longer editable; returned to Session.",
        "warning",
      );
    });
  };
  const loop = (): Promise<void> =>
    openProfileEditor(pi, ctx, bridge, actions, target, profile, reloadRequired).then((result) => {
      if (result === "reloaded") return undefined;
      if (Predicate.isBoolean(result)) {
        if (result)
          ctx.ui.notify(
            "Profile changes are saved. Run /reload to apply them to new subagents.",
            "info",
          );
        return undefined;
      }
      profile = result.profile;
      reloadRequired = result.reloadRequired || reloadRequired;
      if (result.action === "sets")
        return openSets(result.preferredScope).then((setsResult) => {
          if (setsResult === "reloaded") return undefined;
          if (setsResult)
            return requestScope(setsResult.scope).then((scopeResult) =>
              scopeResult === "reloaded" ? undefined : loop(),
            );
          return restoreCurrentTarget().then(loop);
        });
      return requestScope(result.scope).then((scopeResult) =>
        scopeResult === "reloaded" ? undefined : loop(),
      );
    });

  return requestScope(initialScope).then((result) =>
    result === "reloaded" || result === "unresolved" ? undefined : loop(),
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
        "Subagent nesting scope",
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
        return ctx.ui
          .select("Nesting policy", ["Set limits", "Inherit lower-precedence policy"])
          .then((choice) => {
            if (!choice) return;
            if (choice.startsWith("Inherit")) {
              if (scope === "session")
                return actions.patchSessionNesting({
                  expectedRevision: inspection.session.revision,
                });
              const expectedDocument =
                scope === "project" ? inspection.projectDocument : inspection.globalDocument;
              const patch: SubagentNestingPatch = {
                scope,
                expectedExists:
                  scope === "project"
                    ? inspection.projectDocument !== undefined
                    : inspection.globalDocument !== undefined,
                projectTrusted: trusted,
              };
              return actions
                .patchNesting(expectedDocument ? { ...patch, expectedDocument } : patch)
                .then(() =>
                  ctx.ui.notify("Nesting policy saved. Run /reload to apply it.", "info"),
                );
            }
            return ctx.ui
              .input(
                `Maximum direct children (${MIN_DIRECT_CHILDREN}-${MAX_DIRECT_CHILDREN})`,
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
                    "Maximum direct children is outside the accepted integer bounds.",
                    "error",
                  );
                  return;
                }
                return ctx.ui
                  .input(
                    `Maximum depth (${MIN_SUBAGENT_DEPTH}-${MAX_SUBAGENT_DEPTH})`,
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
                        "Maximum depth is outside the accepted integer bounds.",
                        "error",
                      );
                      return;
                    }
                    const nesting = { maxDirectChildren, maxDepth };
                    if (scope === "session")
                      return actions.patchSessionNesting({
                        expectedRevision: inspection.session.revision,
                        nesting,
                      });
                    const expectedDocument =
                      scope === "project" ? inspection.projectDocument : inspection.globalDocument;
                    const patch: SubagentNestingPatch = {
                      scope,
                      nesting,
                      expectedExists:
                        scope === "project"
                          ? inspection.projectDocument !== undefined
                          : inspection.globalDocument !== undefined,
                      projectTrusted: trusted,
                    };
                    return actions
                      .patchNesting(expectedDocument ? { ...patch, expectedDocument } : patch)
                      .then(() =>
                        ctx.ui.notify("Nesting policy saved. Run /reload to apply it.", "info"),
                      );
                  });
              });
          });
      }),
  );
}

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  pi.registerCommand("subagents", {
    description: "Open the subagent fleet or configure profiles",
    getArgumentCompletions: (prefix) =>
      completeSettingsArguments(prefix, [
        {
          id: "profiles",
          description: "Configure profile routes (optionally scoped session/global/project)",
          values: ["session", "global", "project"],
        },
        {
          id: "settings",
          description: "Configure nesting limits",
        },
      ]),
    handler: (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) return openFleetManager(ctx, bridge, actions);
      if (command === "settings") return openNestingSettings(ctx, actions);
      if (command === "profiles" || command === "profiles session")
        return openProfileDashboard(pi, ctx, bridge, actions);
      if (command === "profiles global")
        return openProfileDashboard(pi, ctx, bridge, actions, "global");
      if (command === "profiles project")
        return openProfileDashboard(pi, ctx, bridge, actions, "project");
      ctx.ui.notify(
        "Usage: /subagents [settings | profiles [session|global|project]]; omit arguments for the fleet inspector.",
        "error",
      );
      return Promise.resolve();
    },
  });
}
