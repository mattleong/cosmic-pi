// Pi custom-UI orchestration. Each screen closes before another owns the editor slot.
import * as Predicate from "effect/Predicate";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasObjectRuntimeType, isProjectTrusted } from "pi-cosmic-core";
import { formatFullScreenKeyId, fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import { resolveNamedProfileSet, type ResolvedNamedProfileSet } from "../config/options.ts";
import { normalizeProfileSetName } from "../config/schema.ts";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import { SessionProfileConflictError } from "../profiles/session-overrides.ts";
import type { FleetManagerActions } from "./controller.ts";
import type { ProfileSettingsInspection, ProfileWorkspaceTarget } from "./profile-route-editor.ts";
import type { ProfileWorkspaceCloseResult, ProfileWorkspaceOptions } from "./profile-workspace.ts";
import { ProfileSetPickerComponent, type ProfileSetPickerAction } from "./profile-set-picker.ts";
import { ProfileTargetPickerComponent } from "./profile-target-picker.ts";
import {
  ProfileSetSaveFormComponent,
  type ProfileSetSaveDestination,
} from "./profile-set-save-form.ts";

export type ProfileEditorPosition = Pick<
  ProfileWorkspaceOptions,
  | "initialProfile"
  | "initialField"
  | "initialCandidateIndex"
  | "initialFocus"
  | "initialAdvancedExpanded"
>;
export type OpenProfileEditor = (
  target: ProfileWorkspaceTarget,
  position: ProfileEditorPosition,
) => Promise<ProfileWorkspaceCloseResult>;

const sameTarget = (left: ProfileWorkspaceTarget, right: ProfileWorkspaceTarget): boolean =>
  left.kind === "session"
    ? right.kind === "session"
    : right.kind === "profile-set" &&
      left.set.scope === right.set.scope &&
      left.set.name === right.set.name;

export function openProfileDashboard(
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
  openEditor: OpenProfileEditor,
  initialProfile?: ProfileId,
): Promise<void> {
  let target: ProfileWorkspaceTarget = { kind: "session" };
  let position: ProfileEditorPosition = {
    initialProfile: initialProfile ?? "generalist",
    initialFocus: initialProfile ? "fields" : "profiles",
  };
  const updateTarget = (selected: ProfileWorkspaceTarget): void => {
    if (sameTarget(target, selected)) return;
    target = selected;
    position = { ...position, initialCandidateIndex: 0 };
  };
  const selectTarget = (): Promise<ProfileWorkspaceTarget | undefined> => {
    const trusted = isProjectTrusted(ctx);
    return actions.inspectProfiles(trusted).then((inspection) =>
      ctx.ui.custom<ProfileWorkspaceTarget | undefined>(
        (tui, theme, keybindings, done) =>
          new ProfileTargetPickerComponent({
            theme,
            inspection,
            projectTrusted: trusted,
            target,
            getHeight: () => tui.terminal.rows,
            requestRender: () => tui.requestRender(),
            matchesKeybinding: (data, id) => keybindings.matches(data, id),
            keybindingLabel: (id, fallback) =>
              fullScreenKeybindingLabel(
                id,
                fallback,
                Predicate.isFunction(keybindings.getKeys)
                  ? (key) => keybindings.getKeys(key)
                  : undefined,
              ),
            close: done,
          }),
        { overlay: true },
      ),
    );
  };
  const loop = (): Promise<void> =>
    openEditor(target, position).then((result) => {
      if (result === false) return;
      position = {
        initialProfile: result.profile,
        initialField: result.field,
        initialCandidateIndex: result.candidateIndex,
        initialFocus: result.pane ?? (result.field ? "fields" : "profiles"),
        initialAdvancedExpanded: result.advancedExpanded,
      };
      const action =
        result.action === "save-session"
          ? {
              action: "save-session" as const,
              preferredScope: isProjectTrusted(ctx) ? ("project" as const) : ("global" as const),
            }
          : result.action === "use-current" && target.kind === "profile-set"
            ? { action: "use-current" as const, target: target.set }
            : undefined;
      const next =
        result.action === "select-target"
          ? selectTarget()
          : openProfileSetLibrary(ctx, actions, action, (previous, next) => {
              if (sameTarget(target, previous)) updateTarget(next);
            });
      return next
        .catch((error) => {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Could not open profile settings.",
            "error",
          );
          return undefined;
        })
        .then((selected) => {
          if (selected) updateTarget(selected);
          return loop();
        });
    });
  return loop();
}

export const profileSetPatchBase = (
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

export const isSessionProfileConflict = <ErrorInput>(error: ErrorInput): boolean =>
  error instanceof SessionProfileConflictError ||
  (hasObjectRuntimeType(error) &&
    error !== null &&
    // SAFETY: hasObjectRuntimeType established an object before this optional tag read.
    (error as { readonly _tag?: unknown })._tag === "SessionProfileConflictError");

export const captureProjectWriteTrust = (
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
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
  initialAction?: ProfileSetPickerAction,
  onTargetMutation?: (previous: ProfileWorkspaceTarget, next: ProfileWorkspaceTarget) => void,
): Promise<ProfileWorkspaceTarget | undefined> {
  let nextTarget: ProfileWorkspaceTarget | undefined;
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
          keybindingLabel: (id, fallback) =>
            fullScreenKeybindingLabel(
              id,
              fallback,
              Predicate.isFunction(keybindings.getKeys)
                ? (key) => keybindings.getKeys(key)
                : undefined,
            ),
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
            nextTarget = { kind: "session" };
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
    return ctx.ui
      .custom<ProfileSetSaveDestination | undefined>(
        (tui, theme, keybindings, done) =>
          new ProfileSetSaveFormComponent({
            theme,
            projectTrusted,
            initialScope: action.preferredScope,
            matchesSectionKey: (data) => keybindings.matches(data, "tui.input.tab"),
            sectionKeyLabel: Predicate.isFunction(keybindings.getKeys)
              ? keybindings.getKeys("tui.input.tab").map(formatFullScreenKeyId).join("/") || "Tab"
              : "Tab",
            getHeight: () => tui.terminal.rows,
            requestRender: () => tui.requestRender(),
            matchesKeybinding: (data, id) => keybindings.matches(data, id),
            keybindingLabel: (id, fallback) =>
              fullScreenKeybindingLabel(
                id,
                fallback,
                Predicate.isFunction(keybindings.getKeys)
                  ? (key) => keybindings.getKeys(key)
                  : undefined,
              ),
            close: done,
          }),
        { overlay: true },
      )
      .then((result) => {
        if (!result) return;
        const { scope, name } = result;
        const destination = scope === "project" ? "Project" : "Global";
        preferredScope = scope;
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
  };
  const handleAction = (action: ProfileSetPickerAction): Promise<void> => {
    if (action.action === "clear-scope-default") preferredScope = action.scope;
    else if ("target" in action) preferredScope = action.target.scope;
    if (action.action === "use-current") return applySet(action.target);
    if (action.action === "edit") {
      nextTarget = { kind: "profile-set", set: action.target };
      return Promise.resolve();
    }
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
          .then(() => {
            onTargetMutation?.(
              { kind: "profile-set", set: action.target },
              { kind: "profile-set", set: { ...action.target, name } },
            );
            return refresh();
          });
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
      .then(() => {
        onTargetMutation?.({ kind: "profile-set", set: action.target }, { kind: "session" });
        return refresh();
      });
  };
  const loop = (): Promise<ProfileWorkspaceTarget | undefined> =>
    showPicker().then((action) => {
      if (!action) return;
      return handleAction(action).then(
        () => nextTarget ?? loop(),
        (error) => {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Could not update saved profile sets.",
            "error",
          );
          return refresh().then(loop, () => undefined);
        },
      );
    });
  return refresh()
    .then(() => (initialAction ? handleAction(initialAction).then(() => nextTarget) : loop()))
    .catch((error) => {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Could not inspect profile settings.",
        "error",
      );
      return undefined;
    });
}
