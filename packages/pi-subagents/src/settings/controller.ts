// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSettingsArguments, isProjectTrusted } from "pi-cosmic-core";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import { synchronousNow } from "../boundary/native-clock.ts";
import { startHostUiTicker, type SubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import { normalizeDeclaredProfileRoute } from "../config/options.ts";
import type { SubagentProfilePatch } from "../config/store.ts";
import type { ProfileCandidate, ProfileId } from "../profiles/model.ts";
import {
  SessionProfileConflictError,
  type SessionProfilePatch,
} from "../profiles/session-overrides.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import { isActiveRunState } from "../run/model.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import {
  declaredRouteForDraft,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
} from "./profile-route-editor.ts";
import { loadCandidateModelPicker } from "./ui/candidate-editor.ts";
import { createProfileModelChoices } from "./ui/model-picker.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceSaveResult,
} from "./ui/profile-workspace.ts";

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
  readonly patchSessionProfile: (patch: SessionProfilePatch) => Promise<void>;
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
      unsubscribe = bridge.subscribe(() => {
        manager.invalidate();
        tui.requestRender();
      });
      let lastAgeSecond = -1;
      const stopSpinnerTicker = startHostUiTicker(160, () => {
        const runs = bridge.get().runs;
        if (runs.some((run) => run.state === "starting" || run.state === "running")) {
          tui.requestRender();
          return;
        }
        if (!runs.some((run) => run.endedAt !== undefined)) return;
        const ageSecond = Math.floor(synchronousNow() / 1_000);
        if (ageSecond === lastAgeSecond) return;
        lastAgeSecond = ageSecond;
        tui.requestRender();
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
          stopSpinnerTicker();
          unsubscribe();
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
  );
}

const availablePiModelsForHost = (
  models: ReadonlyArray<Model<Api>>,
  host: ProfileCandidate["host"],
  extensionProviders: ReadonlySet<string> | undefined,
) =>
  host === "local"
    ? models
    : extensionProviders
      ? models.filter((model) => !extensionProviders.has(model.provider))
      : [];

const supportedPiEfforts = (
  candidate: ProfileCandidate,
  models: ReadonlyArray<Model<Api>>,
  parentModel: Model<Api> | undefined,
  extensionProviders: ReadonlySet<string> | undefined,
): ReadonlyArray<SubagentEffort> | undefined => {
  if (candidate.runtime !== "pi") return undefined;
  const choices = createProfileModelChoices({
    models: availablePiModelsForHost(models, candidate.host, extensionProviders),
    parentModel,
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
  ctx: ExtensionCommandContext,
  candidate: ProfileCandidate,
  extensionProviders: ReadonlySet<string> | undefined,
): boolean => {
  if (candidate.runtime === "pi" && candidate.host === "herdr") {
    const slash = candidate.model.indexOf("/");
    const provider = slash > 0 ? candidate.model.slice(0, slash) : undefined;
    if (!provider || !extensionProviders || extensionProviders.has(provider)) return false;
  }
  if (candidate.runtime === "pi" && candidate.model === "parent")
    return ctx.model
      ? supportsSubagentFastMode("pi", `${ctx.model.provider}/${ctx.model.id}`)
      : false;
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

function openProfileSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  initialScope: ProfileSettingsScope = "global",
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !Predicate.isFunction(ctx.ui.custom)) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "/subagents profiles requires interactive TUI mode; edit pi-subagents.json and run /reload.",
        "warning",
      );
    return Promise.resolve();
  }

  const projectTrusted = isProjectTrusted(ctx);
  const selectedInitialScope =
    initialScope === "project" && !projectTrusted ? "global" : initialScope;
  if (selectedInitialScope !== initialScope)
    ctx.ui.notify(
      "Project profile settings require a trusted project; opened Global scope.",
      "warning",
    );
  return actions.inspectProfiles(projectTrusted).then(
    (initialInspection) => {
      let inspection: ProfileSettingsInspection = initialInspection;

      let availableModels = ctx.modelRegistry.getAvailable();
      let parentCatalogModel = ctx.model
        ? ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
        : undefined;
      let requestWorkspaceRender: (() => void) | undefined;
      let modelRefreshNotified = false;
      const modelRefreshController = new AbortController();
      const notifyModelRefreshFailure = (): void => {
        if (modelRefreshNotified || modelRefreshController.signal.aborted) return;
        modelRefreshNotified = true;
        ctx.ui.notify(
          "Could not refresh Pi model catalogs; showing the last authenticated snapshot.",
          "warning",
        );
      };
      const refreshModels = (): Promise<void> =>
        Promise.resolve()
          .then(() => ctx.modelRegistry.refresh({ signal: modelRefreshController.signal }))
          .then(() => {
            if (modelRefreshController.signal.aborted) return;
            if (ctx.modelRegistry.getError()) {
              notifyModelRefreshFailure();
              return;
            }
            availableModels = ctx.modelRegistry.getAvailable();
            parentCatalogModel = ctx.model
              ? ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
              : undefined;
            requestWorkspaceRender?.();
          })
          .catch(() => notifyModelRefreshFailure());
      void refreshModels();
      // Catalog I/O must never hold the settings overlay closed. Immediately resolved refreshes still
      // update the initial snapshot; slower providers finish while the workspace is already visible.
      return Promise.resolve().then(() => {
        let extensionProviders: ReadonlySet<string> | undefined;
        try {
          extensionProviders = new Set(ctx.modelRegistry.getRegisteredProviderIds());
        } catch {
          ctx.ui.notify(
            "Could not inspect Pi provider provenance; Herdr Pi model choices are unavailable.",
            "warning",
          );
        }
        let parentEffort: SubagentEffort = "high";
        if (ctx.model) {
          try {
            parentEffort = decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";
          } catch {
            // Host callback failures use the same conservative fallback as launch resolution.
          }
        }
        const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const herdrModelSelectors = createProfileModelChoices({
          models: extensionProviders
            ? availableModels.filter((model) => !extensionProviders.has(model.provider))
            : [],
          allowParent: false,
        }).flatMap((choice) => (choice.choice.kind === "model" ? [choice.choice.selector] : []));
        const preferredPiModel =
          parentModel && herdrModelSelectors.includes(parentModel)
            ? parentModel
            : herdrModelSelectors[0];
        const refreshInspection = (conflictMessage?: string): Promise<ProfileWorkspaceSaveResult> =>
          Promise.resolve()
            .then(() => actions.inspectProfiles(isProjectTrusted(ctx)))
            .then(
              (nextInspection): ProfileWorkspaceSaveResult => {
                inspection = nextInspection;
                const baseResult = { inspection };
                const withConflictMessage = conflictMessage
                  ? { ...baseResult, conflictMessage }
                  : baseResult;
                return withConflictMessage;
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
          scope: ProfileSettingsScope,
          profile: ProfileId,
          draft: ProfileRouteDraft,
        ): Promise<ProfileWorkspaceSaveResult> => {
          const declaration = declaredRouteForDraft(draft);
          if (!declaration.valid) return Promise.reject(new Error(declaration.error));
          if (scope === "session") {
            return actions
              .patchSessionProfile(
                (() => {
                  const baseResult = { profile };
                  const withRoute =
                    declaration.route === undefined
                      ? baseResult
                      : { ...baseResult, route: normalizeDeclaredProfileRoute(declaration.route) };
                  const withExpectedRevision = {
                    ...withRoute,
                    expectedRevision: inspection.session.revision,
                  };
                  return withExpectedRevision;
                })(),
              )
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
          const expectedDocument =
            scope === "global" ? inspection.globalDocument : inspection.projectDocument;
          return actions
            .patchProfile(
              (() => {
                const baseResult = { scope, profile };
                const withRoute =
                  declaration.route === undefined
                    ? baseResult
                    : { ...baseResult, route: declaration.route };
                const withExpectedExists = {
                  ...withRoute,
                  expectedExists: expectedDocument !== undefined,
                };
                const withExpectedDocument =
                  expectedDocument === undefined
                    ? withExpectedExists
                    : { ...withExpectedExists, expectedDocument };
                const withProjectTrusted = {
                  ...withExpectedDocument,
                  projectTrusted: isProjectTrusted(ctx),
                };
                return withProjectTrusted;
              })(),
            )
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

        return Promise.resolve()
          .then(() =>
            ctx.ui.custom<boolean>(
              (tui, theme, keybindings, done) => {
                requestWorkspaceRender = () => tui.requestRender();
                return new ProfileWorkspaceComponent(
                  (() => {
                    const baseResult = {
                      theme,
                      inspection,
                      projectTrusted,
                      initialScope: selectedInitialScope,
                      parentEffort,
                    };
                    const withPiModel = preferredPiModel
                      ? { ...baseResult, piModel: preferredPiModel }
                      : baseResult;
                    const withParentModel = parentModel
                      ? { ...withPiModel, parentModel }
                      : withPiModel;
                    const withGetHeightAndAdditionalFields = {
                      ...withParentModel,
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
                      ) =>
                        loadCandidateModelPicker(
                          ctx,
                          (() => {
                            const baseResult = {
                              profile,
                              candidateIndex,
                              candidate,
                              listNativeModels: actions.listNativeModels,
                              piModels: availableModels,
                            };
                            const withPiParentModel = parentCatalogModel
                              ? { ...baseResult, piParentModel: parentCatalogModel }
                              : baseResult;
                            const withAdditionalFields = {
                              ...withPiParentModel,
                              ...(extensionProviders
                                ? { registeredPiProviderIds: [...extensionProviders] }
                                : { piProviderInspectionFailed: true }),
                            };
                            const withSignal = signal
                              ? { ...withAdditionalFields, signal }
                              : withAdditionalFields;
                            return withSignal;
                          })(),
                        ),
                      supportedPiEfforts: (candidate: ProfileCandidate) =>
                        supportedPiEfforts(
                          candidate,
                          availableModels,
                          parentCatalogModel,
                          extensionProviders,
                        ),
                      fastModeAvailable: (candidate: ProfileCandidate) =>
                        fastModeAvailable(ctx, candidate, extensionProviders),
                      reload: () => requestProfileReload(ctx, bridge),
                    };
                    return withGetHeightAndAdditionalFields;
                  })(),
                );
              },
              {
                overlay: true,
                overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
              },
            ),
          )
          .then(
            (reloadRequired) => {
              if (reloadRequired)
                ctx.ui.notify(
                  "Profile changes are saved. Run /reload to apply them to new subagents.",
                  "info",
                );
            },
            () => {
              ctx.ui.notify(
                "Could not open Subagents profile settings. Run /reload and try again; inspect the Pi logs if the problem continues.",
                "error",
              );
            },
          )
          .finally(() => {
            requestWorkspaceRender = undefined;
            modelRefreshController.abort();
          });
      });
    },
    (error) => {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Could not inspect profile settings.",
        "error",
      );
    },
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
      ]),
    handler: (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) return openFleetManager(ctx, bridge, actions);
      if (command === "profiles") return openProfileSettings(pi, ctx, bridge, actions);
      if (command === "profiles session")
        return openProfileSettings(pi, ctx, bridge, actions, "session");
      if (command === "profiles global")
        return openProfileSettings(pi, ctx, bridge, actions, "global");
      if (command === "profiles project")
        return openProfileSettings(pi, ctx, bridge, actions, "project");
      ctx.ui.notify(
        "Usage: /subagents [profiles [session|global|project]] — omit arguments for the fleet inspector.",
        "error",
      );
      return Promise.resolve();
    },
  });
}
