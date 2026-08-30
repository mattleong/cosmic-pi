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
import { resolveNamedProfileSet, type ResolvedNamedProfileSet } from "../config/options.ts";
import {
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_SUBAGENT_DEPTH,
  normalizeProfileSetName,
  type SubagentNestingPolicy,
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
import {
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import {
  SessionProfileConflictError,
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
import { ProfileSetPickerComponent, type ProfileSetPickerAction } from "./profile-set-picker.ts";

export interface SessionProfileSetSnapshotWrite extends Omit<
  SubagentCreateProfileSetFromSnapshotPatch,
  "profiles"
> {
  readonly expectedRevision: number;
}

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
  readonly createProfileSetFromSnapshot: (patch: SessionProfileSetSnapshotWrite) => Promise<void>;
  readonly copyProfileSet: (patch: SubagentCopyProfileSetPatch) => Promise<void>;
  readonly renameProfileSet: (patch: SubagentRenameProfileSetPatch) => Promise<void>;
  readonly deleteProfileSet: (patch: SubagentDeleteProfileSetPatch) => Promise<void>;
  readonly patchNesting: (patch: SubagentNestingPatch) => Promise<void>;
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

const isSessionProfileConflict = <ErrorInput>(error: ErrorInput): boolean =>
  error instanceof SessionProfileConflictError ||
  (hasObjectRuntimeType(error) &&
    error !== null &&
    // SAFETY: hasObjectRuntimeType established an object before this optional tag read.
    (error as { readonly _tag?: unknown })._tag === "SessionProfileConflictError");

const captureProjectWriteTrust = (
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  message: string,
): { readonly projectTrusted: boolean } | undefined => {
  const projectTrusted = isProjectTrusted(ctx);
  if (scope === "project" && !projectTrusted) {
    ctx.ui.notify(message, "warning");
    return undefined;
  }
  return { projectTrusted };
};

function openProfileEditor(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
  target: ProfileWorkspaceTarget,
  initialProfile: ProfileId = "generalist",
): Promise<ProfileWorkspaceCloseResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !Predicate.isFunction(ctx.ui.custom)) {
    if (ctx.hasUI) ctx.ui.notify("/subagents profiles requires interactive TUI mode.", "warning");
    return Promise.resolve(false);
  }
  const projectTrusted = isProjectTrusted(ctx);
  if (target.kind === "profile-set" && target.set.scope === "project" && !projectTrusted) {
    ctx.ui.notify("Trust this project to edit its saved profile sets.", "warning");
    return Promise.resolve(false);
  }
  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      let inspection = initialInspection;
      const modelCatalog = new ProfileModelCatalog(ctx.modelRegistry);
      let requestWorkspaceRender: (() => void) | undefined;
      const modelRefreshController = new AbortController();
      let refreshWarningSent = false;
      void modelCatalog.refresh(modelRefreshController.signal).then((result) => {
        if (result === "updated" && !modelRefreshController.signal.aborted)
          requestWorkspaceRender?.();
        if (result === "failed" && !modelRefreshController.signal.aborted && !refreshWarningSent) {
          refreshWarningSent = true;
          ctx.ui.notify("Could not refresh Pi models. Showing the last available list.", "warning");
        }
      });
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
          .then(() => refreshInspection());
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
              initialProfile,
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

const replacementPreview = (resolved: ResolvedNamedProfileSet): string =>
  PROFILE_IDS.map((profile) => {
    const candidates = resolved.profiles[profile].candidates;
    const route = candidates[0]
      ? `${candidates[0].model}${candidates.length > 1 ? ` + ${candidates.length - 1} fallback${candidates.length === 2 ? "" : "s"}` : ""}`
      : "disabled";
    return `${profile}: ${route}`;
  }).join("\n");

const hasInvalidEffectiveProfileSource = (inspection: ProfileSettingsInspection): boolean =>
  PROFILE_IDS.some((profile) => {
    const source = inspection.session.effectiveConfig.profileSources[profile];
    return source === "global-invalid" || source === "project-invalid";
  });

function openProfileSetLibrary(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
  initialProfile: ProfileId,
): Promise<void> {
  let inspection: ProfileSettingsInspection;
  let projectTrusted = isProjectTrusted(ctx);
  let preferredScope: "global" | "project" = projectTrusted ? "project" : "global";

  const refresh = (): Promise<void> => {
    projectTrusted = isProjectTrusted(ctx);
    return actions.inspectProfiles(projectTrusted).then((next) => {
      inspection = next;
    });
  };
  const promptName = (title: string, initial = ""): Promise<string | undefined> =>
    ctx.ui.input(title, initial).then((value) => {
      if (value === undefined) return undefined;
      const normalized = normalizeProfileSetName(value);
      if (normalized) return normalized;
      ctx.ui.notify(
        "Use 1 to 64 characters. Start and end with a letter or number. Spaces, periods, underscores, and hyphens are allowed.",
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
          initialScope: preferredScope,
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
  const applySet = (target: { readonly scope: "global" | "project"; readonly name: string }) => {
    if (target.scope === "project" && !isProjectTrusted(ctx)) {
      ctx.ui.notify("Trust this project to use its saved profile sets.", "warning");
      return refresh();
    }
    const resolveInput = {
      scope: target.scope,
      name: target.name,
      global: inspection.global,
    };
    const resolved = resolveNamedProfileSet(
      inspection.project ? { ...resolveInput, project: inspection.project } : resolveInput,
    );
    if (resolved.status !== "resolved" || resolved.invalidProfiles.length > 0) {
      ctx.ui.notify(
        "This saved set is invalid. Fix it before using it in Current Session.",
        "warning",
      );
      return Promise.resolve();
    }
    const expectedRevision = inspection.session.revision;
    return ctx.ui
      .confirm(
        `Use ${target.scope === "project" ? "Project" : "Global"}/${target.name} in Current Session?`,
        `This replaces all seven Current Session profiles. Later changes to Current Session or the saved set will stay separate. Active runs will not change.\n\n${replacementPreview(resolved)}`,
      )
      .then((confirmed) => {
        if (!confirmed) return;
        if (target.scope === "project" && !isProjectTrusted(ctx)) {
          ctx.ui.notify(
            "This project is no longer trusted. Current Session was not changed.",
            "warning",
          );
          return refresh();
        }
        return actions
          .replaceSessionProfiles({
            origin: resolved.origin,
            profiles: resolved.profiles,
            profileSources: resolved.profileSources,
            expectedRevision,
          })
          .then(
            () => refresh().then(() => true),
            (error) => {
              if (isSessionProfileConflict(error))
                return refresh().then(() => {
                  ctx.ui.notify(
                    "Current Session changed before this update could be applied. Nothing was replaced.",
                    "warning",
                  );
                  return false;
                });
              throw error;
            },
          )
          .then((replaced) => {
            if (!replaced) return;
            ctx.ui.notify(
              `Copied ${target.scope === "project" ? "Project" : "Global"}/${target.name} into Current Session. Later changes to either one will not affect the other. Active runs did not change.`,
              "info",
            );
          });
      });
  };
  const saveSession = (action: Extract<ProfileSetPickerAction, { action: "save-session" }>) => {
    if (hasInvalidEffectiveProfileSource(inspection)) {
      ctx.ui.notify(
        "Current Session has invalid profiles. Fix or disable them in Current Session before saving a set.",
        "warning",
      );
      return Promise.resolve();
    }
    const displayedRevision = inspection.session.revision;
    const destinationChoices = projectTrusted
      ? action.preferredScope === "project"
        ? ["Project", "Global"]
        : ["Global", "Project"]
      : ["Global"];
    return ctx.ui.select("Save Current Session as", destinationChoices).then((destination) => {
      if (!destination) return;
      const scope = destination === "Project" ? "project" : "global";
      preferredScope = scope;
      return promptName(`Name for new ${destination} set`).then((name) => {
        if (!name) return;
        const inspectionTrust = isProjectTrusted(ctx);
        return actions.inspectProfiles(inspectionTrust).then((latest) => {
          inspection = latest;
          if (latest.session.revision !== displayedRevision) {
            ctx.ui.notify(
              "Current Session changed while you were choosing where to save it. Nothing was saved. Review the latest profiles and try again.",
              "warning",
            );
            return;
          }
          if (hasInvalidEffectiveProfileSource(latest)) {
            ctx.ui.notify(
              "Current Session has invalid profiles. Fix or disable them in Current Session before saving a set.",
              "warning",
            );
            return;
          }
          const writeTrust = captureProjectWriteTrust(
            ctx,
            scope,
            "This project is no longer trusted. Nothing was saved.",
          );
          projectTrusted = writeTrust?.projectTrusted ?? false;
          if (!writeTrust) return;
          return actions
            .createProfileSetFromSnapshot({
              ...profileSetPatchBase(latest, scope, writeTrust.projectTrusted),
              profileSet: name,
              expectedRevision: displayedRevision,
            })
            .then(
              () =>
                refresh().then(() => {
                  ctx.ui.notify(
                    `Saved all seven Current Session profiles as ${destination}/${name}. The default for new sessions did not change.`,
                    "info",
                  );
                }),
              (error) => {
                if (!isSessionProfileConflict(error)) throw error;
                return refresh().then(() => {
                  ctx.ui.notify(
                    "Current Session changed while the set was being saved. Nothing was saved. Review the latest profiles and try again.",
                    "warning",
                  );
                });
              },
            );
        });
      });
    });
  };
  const handleAction = (action: ProfileSetPickerAction): Promise<void> => {
    if (action.action === "clear-scope-default") preferredScope = action.scope;
    else if ("target" in action) preferredScope = action.target.scope;
    if (action.action === "use-current") return applySet(action.target);
    if (action.action === "edit")
      return openProfileEditor(
        pi,
        ctx,
        actions,
        { kind: "profile-set", set: action.target },
        initialProfile,
      ).then(() => refresh());
    if (action.action === "make-default")
      return refresh().then(() => {
        const resolveInput = {
          scope: action.target.scope,
          name: action.target.name,
          global: inspection.global,
        };
        const resolved = resolveNamedProfileSet(
          inspection.project ? { ...resolveInput, project: inspection.project } : resolveInput,
        );
        if (resolved.status !== "resolved" || resolved.invalidProfiles.length > 0) {
          ctx.ui.notify(
            "This saved set is invalid. Fix or recreate it before making it the default.",
            "warning",
          );
          return;
        }
        const writeTrust = captureProjectWriteTrust(
          ctx,
          action.target.scope,
          "This project is no longer trusted. The default did not change.",
        );
        projectTrusted = writeTrust?.projectTrusted ?? false;
        if (!writeTrust) return;
        return actions
          .patchDefaultProfileSet({
            ...profileSetPatchBase(inspection, action.target.scope, writeTrust.projectTrusted),
            defaultProfileSet: action.target.name,
          })
          .then(() => refresh())
          .then(() => {
            const projectSelection = inspection.config.currentProfileSet;
            const shadowed =
              action.target.scope === "global" && projectSelection.scope === "project";
            const shadowNotice = shadowed ? " This project's default still takes priority." : "";
            ctx.ui.notify(
              `${action.target.scope === "project" ? "Project" : "Global"}/${action.target.name} is now the default for new sessions.${shadowNotice} Current Session did not change.`,
              "info",
            );
          });
      });
    if (action.action === "clear-scope-default") {
      const selectedName =
        action.scope === "project"
          ? inspection.project?.file.defaultProfileSet
          : inspection.global.file.defaultProfileSet;
      const writeTrust = captureProjectWriteTrust(
        ctx,
        action.scope,
        "This project is no longer trusted. The default did not change.",
      );
      projectTrusted = writeTrust?.projectTrusted ?? false;
      if (!writeTrust) return refresh();
      return actions
        .patchDefaultProfileSet({
          ...profileSetPatchBase(inspection, action.scope, writeTrust.projectTrusted),
        })
        .then(() => refresh())
        .then(() => {
          const scopeLabel = action.scope === "project" ? "Project" : "Global";
          const inheritance =
            action.scope === "project"
              ? "New sessions in this project will use Global, then built-in profiles."
              : "New sessions without a Project default will use built-in profiles.";
          const savedNotice = selectedName ? ` ${scopeLabel}/${selectedName} is still saved.` : "";
          ctx.ui.notify(
            `${scopeLabel} will no longer use a saved set by default. ${inheritance}${savedNotice} Current Session did not change.`,
            "info",
          );
        });
    }
    if (action.action === "save-session") return saveSession(action);
    if (action.action === "copy") {
      preferredScope = action.source.scope;
      return promptName(
        `Copy ${action.source.scope === "project" ? "Project" : "Global"}/${action.source.name} as`,
        `${action.source.name} copy`,
      ).then((name) => {
        if (!name) return;
        const writeTrust = captureProjectWriteTrust(
          ctx,
          action.source.scope,
          "This project is no longer trusted. Nothing was saved.",
        );
        projectTrusted = writeTrust?.projectTrusted ?? false;
        if (!writeTrust) return refresh();
        return actions
          .copyProfileSet({
            ...profileSetPatchBase(inspection, action.source.scope, writeTrust.projectTrusted),
            sourceProfileSet: action.source.name,
            profileSet: name,
          })
          .then(() => refresh());
      });
    }
    if (action.action === "rename")
      return promptName("New name for saved set", action.target.name).then((name) => {
        if (!name) return;
        const writeTrust = captureProjectWriteTrust(
          ctx,
          action.target.scope,
          "This project is no longer trusted. Nothing was saved.",
        );
        projectTrusted = writeTrust?.projectTrusted ?? false;
        if (!writeTrust) return refresh();
        return actions
          .renameProfileSet({
            ...profileSetPatchBase(inspection, action.target.scope, writeTrust.projectTrusted),
            profileSet: action.target.name,
            nextProfileSet: name,
          })
          .then(() => refresh());
      });
    const writeTrust = captureProjectWriteTrust(
      ctx,
      action.target.scope,
      "This project is no longer trusted. Nothing was deleted.",
    );
    projectTrusted = writeTrust?.projectTrusted ?? false;
    if (!writeTrust) return refresh();
    return actions
      .deleteProfileSet({
        ...profileSetPatchBase(inspection, action.target.scope, writeTrust.projectTrusted),
        profileSet: action.target.name,
      })
      .then(() => refresh());
  };
  const loop = (): Promise<void> =>
    showPicker().then((action) => {
      if (!action) return;
      return handleAction(action).then(
        () => loop(),
        (error) => {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Could not update saved profile sets.",
            "error",
          );
          return refresh().then(loop, () => undefined);
        },
      );
    });
  return refresh().then(loop, (error) => {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Could not inspect profile settings.",
      "error",
    );
  });
}

function openProfileDashboard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
): Promise<void> {
  let profile: ProfileId = "generalist";
  const loop = (): Promise<void> =>
    openProfileEditor(pi, ctx, actions, { kind: "session" }, profile).then((result) => {
      if (result === false) return;
      profile = result.profile;
      return openProfileSetLibrary(pi, ctx, actions, profile).then(loop);
    });
  return loop();
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
        return ctx.ui
          .select("Choose nesting limits", ["Set limits", "Inherit limits"])
          .then((choice) => {
            if (!choice) return;
            if (choice.startsWith("Inherit")) {
              if (scope === "session")
                return actions.patchSessionNesting({
                  expectedRevision: inspection.session.revision,
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
                })
                .then(() =>
                  ctx.ui.notify("Nesting limits saved. Run /reload to apply them.", "info"),
                );
            }
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
                    const nesting = { maxDirectChildren, maxDepth };
                    if (scope === "session")
                      return actions.patchSessionNesting({
                        expectedRevision: inspection.session.revision,
                        nesting,
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
                        nesting,
                      })
                      .then(() =>
                        ctx.ui.notify("Nesting limits saved. Run /reload to apply them.", "info"),
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
        { id: "profiles", description: "Edit Current Session profiles and saved sets" },
        { id: "settings", description: "Configure nesting limits" },
      ]),
    handler: (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) return openFleetManager(ctx, bridge, actions);
      if (command === "settings") return openNestingSettings(ctx, actions);
      if (command === "profiles") return openProfileDashboard(pi, ctx, actions);
      ctx.ui.notify(
        "Usage: /subagents [settings | profiles]; omit arguments for the fleet inspector.",
        "error",
      );
      return Promise.resolve();
    },
  });
}
