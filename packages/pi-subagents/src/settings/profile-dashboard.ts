// The dashboard owns one Pi custom-UI lifetime and its cancellable catalog.
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback, isProjectTrusted } from "pi-cosmic-core";
import { hasCustomSurface, openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { SubagentConfigStoreError } from "../config/store.ts";
import { normalizeDeclaredProfileRoute, type ProfileId } from "../profiles/model.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import {
  declaredRouteForDraft,
  type ProfileRouteDraft,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import {
  loadCandidateModelPicker,
  ProfileModelCatalog,
  supportedPiEfforts,
} from "./profile-model-catalog.ts";
import type { ProfileWorkspaceOptions, ProfileWorkspaceSaveResult } from "./profile-workspace.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";
import { ProfileDashboardComponent } from "./profile-dashboard-component.ts";
import type { ProfileEditRestore, ProfileEditCommitReceipt } from "./profile-edit-visit.ts";
import type { FleetManagerActions } from "./controller.ts";

export type ProfileEditorPosition = Pick<
  ProfileWorkspaceOptions,
  "initialProfile" | "initialFocus"
>;

export function openProfileDashboard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  actions: FleetManagerActions,
  position: ProfileEditorPosition,
): Promise<void> {
  if (!ctx.hasUI || !hasCustomSurface(ctx)) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "Open Pi in an interactive terminal to change agent profiles with /subagents profiles.",
        "warning",
      );
    return Promise.resolve();
  }
  const projectTrusted = isProjectTrusted(ctx);
  const refreshOwner = actions.captureModelRefresh();
  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      if (!refreshOwner.isCurrent()) return;
      let inspection = initialInspection;
      let disposed = false;
      const isCurrent = () => !disposed && refreshOwner.isCurrent();
      const modelCatalog = new ProfileModelCatalog(
        ctx.modelRegistry,
        (ctx.scopedModels ?? []).map(({ model }) => model),
      );
      let requestWorkspaceRender: (() => void) | undefined;
      const modelRefreshController = new AbortController();
      void refreshOwner.run(modelCatalog.refresh(), modelRefreshController.signal).then(
        (result) => {
          if (!refreshOwner.isCurrent() || modelRefreshController.signal.aborted) return;
          if (result === "updated") requestWorkspaceRender?.();
          if (result === "failed")
            ctx.ui.notify(
              "Could not refresh Pi models. Showing the last available list.",
              "warning",
            );
        },
        () => undefined,
      );
      // Launch resolution uses the same conservative fallback.
      const parentEffort: SubagentEffort = ctx.model
        ? invokeHostCallback(() => decodeSubagentEffort(pi.getThinkingLevel()) ?? "high", "high")
        : "high";
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
              (snapshot) => refreshInspection(undefined, { kind: "session", snapshot }),
              (error) => {
                if (Predicate.isTagged(error, "SessionProfileConflictError"))
                  return refreshInspection(
                    "Current Session changed while you were editing. The editor now shows the latest profiles. Try again.",
                  );
                throw error;
              },
            );
        const scope = editorTarget.set.scope;
        const projectTrusted = isProjectTrusted(ctx);
        if (scope === "project" && !projectTrusted) {
          ctx.ui.notify("This project is no longer trusted. Nothing was saved.", "warning");
          return refreshInspection();
        }
        const base = {
          ...profileSetPatchBase(inspection, scope, projectTrusted),
          profileSet: editorTarget.set.name,
          profile,
        };
        return (
          restore
            ? actions.restoreProfileDeclaration({ ...base, ...restore })
            : actions.patchProfile({
                ...base,
                ...(declaration.route !== undefined && { route: declaration.route }),
              })
        ).then(
          (document) => refreshInspection(undefined, { kind: "saved", document }),
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
      const release = () => {
        disposed = true;
        requestWorkspaceRender = undefined;
        modelRefreshController.abort();
      };
      let dashboard: ProfileDashboardComponent | undefined;
      let closeSurface = () => {};
      return openOwnedSurfacePromise<undefined>(ctx, {
        placement: "screen",
        closedValue: undefined,
        onControl: (close) => {
          closeSurface = close;
        },
        onClose: () => dashboard?.dispose(),
        create: ({ tui, theme, keybindings, getHeight, finish }) => {
          requestWorkspaceRender = () => tui.requestRender();
          const workspace: ProfileWorkspaceOptions = {
            theme,
            inspection,
            target: { kind: "session" },
            ...position,
            parentEffort,
            getHeight,
            requestRender: () => tui.requestRender(),
            ...fullScreenKeybindingOptions(keybindings),
            close: () => finish(undefined),
            saveDraft,
            loadModelPicker: (profile, candidateIndex, candidate, signal, modelPending) =>
              loadCandidateModelPicker({
                profile,
                candidateIndex,
                candidate,
                listNativeModels: actions.listNativeModels,
                piCatalog: modelCatalog.capture(),
                parentSelector: parentModel,
                signal,
                modelPending,
              }),
            supportedPiEfforts: (candidate) =>
              supportedPiEfforts({
                candidate,
                piCatalog: modelCatalog.capture(),
                parentSelector: parentModel,
              }),
            parentModel,
          };
          dashboard = new ProfileDashboardComponent({
            workspace,
            ctx,
            actions,
            isCurrent,
            onDispose: release,
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
          // Its finalizer closes the owned surface even with no further input.
          void refreshOwner
            .run(
              Effect.callback<never>(() => Effect.sync(() => closeSurface())),
              modelRefreshController.signal,
            )
            .catch(() => closeSurface());
          return dashboard;
        },
      })
        .then((outcome) => {
          if (outcome._tag === "Failed")
            ctx.ui.notify(
              "Could not open Subagents profile settings. Close and try again.",
              "error",
            );
        })
        .finally(release);
    },
    (error) => {
      // A replaced activation's inspection fails with that replacement; its stale ctx stays quiet.
      if (!refreshOwner.isCurrent()) return;
      ctx.ui.notify(
        error instanceof Error ? error.message : "Could not inspect profile settings.",
        "error",
      );
    },
  );
}
