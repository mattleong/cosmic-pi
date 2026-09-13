// The dashboard owns one Pi custom-UI lifetime and its cancellable catalog.
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import { SubagentConfigStoreError } from "../config/store.ts";
import {
  normalizeDeclaredProfileRoute,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import type { SessionProfilePatch } from "../profiles/session-overrides.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import {
  declaredRouteForDraft,
  type ProfileRouteDraft,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import {
  loadCandidateModelPicker,
  preferredHerdrPiSelector,
  ProfileModelCatalog,
  type ProfileModelCatalogSnapshot,
} from "./profile-model-catalog.ts";
import { createProfileModelChoices } from "./ui/model-picker.ts";
import type {
  ProfileWorkspaceCloseResult,
  ProfileWorkspaceOptions,
  ProfileWorkspaceSaveResult,
} from "./profile-workspace.ts";
import {
  profileSetPatchBase,
  isSessionProfileConflict,
  captureProjectWriteTrust,
} from "./profile-write-context.ts";
import { ProfileDashboardComponent } from "./profile-dashboard-component.ts";
import type { ProfileEditRestore, ProfileEditCommitReceipt } from "./profile-edit-visit.ts";
import type { FleetManagerActions } from "./controller.ts";

export type ProfileEditorPosition = Pick<
  ProfileWorkspaceOptions,
  | "initialProfile"
  | "initialField"
  | "initialCandidateIndex"
  | "initialFocus"
  | "initialAdvancedExpanded"
>;

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

export function openProfileDashboard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
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
  const refreshOwner = actions.captureModelRefresh();
  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      if (!refreshOwner.isCurrent()) return false;
      let inspection = initialInspection;
      let disposed = false;
      const isCurrent = () => !disposed && refreshOwner.isCurrent();
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
      const refreshInspection = (
        conflictMessage?: string,
        receipt?: ProfileEditCommitReceipt,
      ): Promise<ProfileWorkspaceSaveResult> =>
        (isCurrent()
          ? actions.inspectProfiles(isProjectTrusted(ctx))
          : Promise.reject(new Error("Profile dashboard closed."))
        ).then(
          (next): ProfileWorkspaceSaveResult => {
            if (!isCurrent()) return { refreshError: "Profile dashboard closed." };
            inspection = next;
            return {
              inspection,
              ...(conflictMessage && { conflictMessage }),
              ...(receipt && { receipt }),
            };
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
        restore?: ProfileEditRestore,
      ): Promise<ProfileWorkspaceSaveResult> => {
        if (!isCurrent()) return Promise.reject(new Error("Profile dashboard closed."));
        const declaration = declaredRouteForDraft(draft);
        if (!declaration.valid) return Promise.reject(new Error(declaration.error));
        if (editorTarget.kind === "session") {
          const patch: SessionProfilePatch = {
            profile,
            ...(declaration.route !== undefined && {
              route: normalizeDeclaredProfileRoute(declaration.route),
            }),
            expectedRevision: inspection.session.revision,
          };
          const saved = actions.patchSessionProfileWithReceipt
            ? actions
                .patchSessionProfileWithReceipt(patch)
                .then((snapshot): ProfileEditCommitReceipt => ({ kind: "session", snapshot }))
            : actions.patchSessionProfile(patch).then(() => undefined);
          return saved.then(
            (receipt) => refreshInspection(undefined, receipt),
            (error) => {
              if (isSessionProfileConflict(error))
                return refreshInspection(
                  "Current Session changed while you were editing. The editor now shows the latest profiles. Try again.",
                );
              throw error;
            },
          );
        }
        const scope = editorTarget.set.scope;
        const writeTrust = captureProjectWriteTrust(
          ctx,
          scope,
          "This project is no longer trusted. Nothing was saved.",
        );
        if (!writeTrust) return refreshInspection();
        const base = {
          ...profileSetPatchBase(inspection, scope, writeTrust.projectTrusted),
          profileSet: editorTarget.set.name,
          profile,
        };
        if (restore && !actions.restoreProfileDeclaration)
          return Promise.reject(
            new Error(
              "Exact saved-profile undo is unavailable. Reopen after reloading the extension.",
            ),
          );
        const patch = {
          ...base,
          ...(declaration.route !== undefined && { route: declaration.route }),
        };
        const saved = restore
          ? actions.restoreProfileDeclaration!({ ...base, ...restore }).then(
              (document): ProfileEditCommitReceipt => ({ kind: "saved", document }),
            )
          : actions.patchProfileWithReceipt
            ? actions
                .patchProfileWithReceipt(patch)
                .then((document): ProfileEditCommitReceipt => ({ kind: "saved", document }))
            : actions.patchProfile(patch).then(() => undefined);
        return saved.then(
          (receipt) => refreshInspection(undefined, receipt),
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
            let dashboard: ProfileDashboardComponent | undefined;
            let closed = false;
            const close = (result: ProfileWorkspaceCloseResult): void => {
              if (closed) return;
              closed = true;
              dashboard?.dispose();
              done(result);
            };
            const baseOptions: ProfileWorkspaceOptions = {
              theme,
              inspection,
              projectTrusted,
              target: { kind: "session" },
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
              close,
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
                disposed = true;
                requestWorkspaceRender = undefined;
                modelRefreshController.abort();
              },
            };
            dashboard = new ProfileDashboardComponent({
              workspace: parentModel ? { ...baseOptions, parentModel } : baseOptions,
              ctx,
              actions,
              isCurrent,
              onInspection: (next) => {
                if (isCurrent()) inspection = next;
              },
              awaitDialog: (register) =>
                refreshOwner.run(
                  Effect.callback((resume) => {
                    const cleanup = register((value) => resume(Effect.succeed(value)));
                    return Effect.sync(cleanup);
                  }),
                  modelRefreshController.signal,
                ),
            });
            // The activation runtime interrupts this wait on replacement/shutdown.
            // Its finalizer settles Pi's custom-UI promise even with no further input.
            void refreshOwner
              .run(
                Effect.callback<never>(() => Effect.sync(() => close(false))),
                modelRefreshController.signal,
              )
              .catch(() => close(false));
            return dashboard;
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
          disposed = true;
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
