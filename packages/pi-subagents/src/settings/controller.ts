// Pi command and custom-UI handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import {
  fullScreenKeybindingLabel,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keybindings";
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
import { decodeSubagentEffort, isActiveRunState, type SubagentEffort } from "../run/model.ts";
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

async function openFleetManager(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    if (ctx.hasUI) ctx.ui.notify("/subagents requires interactive TUI mode.", "warning");
    return;
  }
  if (!actions.isAvailable()) {
    ctx.ui.notify("Subagents are not active. Run /reload, then reopen /subagents.", "warning");
    return;
  }
  await ctx.ui.custom<void>(
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
            typeof keybindings.getKeys === "function"
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

async function requestProfileReload(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
): Promise<boolean> {
  const active = bridge.get().runs.some((run) => isActiveRunState(run.state));
  const reload = await ctx.ui.confirm(
    "Reload profile settings now?",
    active
      ? "Active subagent runs exist. Reloading stops all session-scoped runs. Continue?"
      : "Reload now to apply the saved profile routes?",
  );
  if (!reload) return false;
  await ctx.reload();
  return true;
}

async function openProfileSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  initialScope: ProfileSettingsScope = "global",
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
    if (ctx.hasUI)
      ctx.ui.notify(
        "/subagents profiles requires interactive TUI mode; edit pi-subagents.json and run /reload.",
        "warning",
      );
    return;
  }

  const projectTrusted = isProjectTrusted(ctx);
  const selectedInitialScope =
    initialScope === "project" && !projectTrusted ? "global" : initialScope;
  if (selectedInitialScope !== initialScope)
    ctx.ui.notify(
      "Project profile settings require a trusted project; opened Global scope.",
      "warning",
    );
  let inspection: ProfileSettingsInspection;
  try {
    inspection = await actions.inspectProfiles(projectTrusted);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Could not inspect profile settings.",
      "error",
    );
    return;
  }

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
  const refreshModels = async (): Promise<void> => {
    try {
      await ctx.modelRegistry.refresh({ signal: modelRefreshController.signal });
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
    } catch {
      notifyModelRefreshFailure();
    }
  };
  void refreshModels();
  // Catalog I/O must never hold the settings overlay closed. Immediately resolved refreshes still
  // update the initial snapshot; slower providers finish while the workspace is already visible.
  await Promise.resolve();
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
    parentModel && herdrModelSelectors.includes(parentModel) ? parentModel : herdrModelSelectors[0];
  const refreshInspection = async (
    conflictMessage?: string,
  ): Promise<ProfileWorkspaceSaveResult> => {
    try {
      inspection = await actions.inspectProfiles(isProjectTrusted(ctx));
      return { inspection, ...(conflictMessage ? { conflictMessage } : {}) };
    } catch {
      return {
        refreshError:
          "Profile settings changed, but the workspace could not refresh. Reopen /subagents profiles before editing again.",
      };
    }
  };
  const saveDraft = async (
    scope: ProfileSettingsScope,
    profile: ProfileId,
    draft: ProfileRouteDraft,
  ): Promise<ProfileWorkspaceSaveResult> => {
    const declaration = declaredRouteForDraft(draft);
    if (!declaration.valid) throw new Error(declaration.error);
    if (scope === "session") {
      try {
        await actions.patchSessionProfile({
          profile,
          ...(declaration.route === undefined
            ? {}
            : { route: normalizeDeclaredProfileRoute(declaration.route) }),
          expectedRevision: inspection.session.revision,
        });
      } catch (error) {
        if (
          error instanceof SessionProfileConflictError ||
          (typeof error === "object" &&
            error !== null &&
            (error as { readonly _tag?: unknown })._tag === "SessionProfileConflictError")
        )
          return refreshInspection(
            "Session profile settings changed concurrently; refreshed the active routes. Retry your edit.",
          );
        throw error;
      }
    } else {
      const expectedDocument =
        scope === "global" ? inspection.globalDocument : inspection.projectDocument;
      await actions.patchProfile({
        scope,
        profile,
        ...(declaration.route === undefined ? {} : { route: declaration.route }),
        expectedExists: expectedDocument !== undefined,
        ...(expectedDocument === undefined ? {} : { expectedDocument }),
        projectTrusted: isProjectTrusted(ctx),
      });
    }
    return refreshInspection();
  };
  const clearSessionOverrides = async (): Promise<ProfileWorkspaceSaveResult> => {
    try {
      await actions.clearSessionProfiles(inspection.session.revision);
      return refreshInspection();
    } catch (error) {
      if (
        error instanceof SessionProfileConflictError ||
        (typeof error === "object" &&
          error !== null &&
          (error as { readonly _tag?: unknown })._tag === "SessionProfileConflictError")
      )
        return refreshInspection(
          "Session profile settings changed concurrently; refreshed the active routes. Retry clearing them.",
        );
      throw error;
    }
  };

  try {
    const reloadRequired = await ctx.ui.custom<boolean>(
      (tui, theme, keybindings, done) => {
        requestWorkspaceRender = () => tui.requestRender();
        return new ProfileWorkspaceComponent({
          theme,
          inspection,
          projectTrusted,
          initialScope: selectedInitialScope,
          parentEffort,
          ...(preferredPiModel ? { piModel: preferredPiModel } : {}),
          ...(parentModel ? { parentModel } : {}),
          getHeight: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          matchesKeybinding: (data, id) => keybindings.matches(data, id),
          keybindingLabel: (id, fallback) =>
            fullScreenKeybindingLabel(
              id,
              fallback,
              typeof keybindings.getKeys === "function"
                ? (key: FullScreenSelectionKeybindingId) => keybindings.getKeys(key)
                : undefined,
            ),
          close: done,
          saveDraft,
          clearSessionOverrides,
          loadModelPicker: (profile, candidateIndex, candidate, signal) =>
            loadCandidateModelPicker(ctx, {
              profile,
              candidateIndex,
              candidate,
              listNativeModels: actions.listNativeModels,
              piModels: availableModels,
              ...(parentCatalogModel ? { piParentModel: parentCatalogModel } : {}),
              ...(extensionProviders
                ? { registeredPiProviderIds: [...extensionProviders] }
                : { piProviderInspectionFailed: true }),
              ...(signal ? { signal } : {}),
            }),
          supportedPiEfforts: (candidate) =>
            supportedPiEfforts(candidate, availableModels, parentCatalogModel, extensionProviders),
          fastModeAvailable: (candidate) => fastModeAvailable(ctx, candidate, extensionProviders),
          reload: () => requestProfileReload(ctx, bridge),
        });
      },
      { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
    );
    if (reloadRequired)
      ctx.ui.notify(
        "Profile changes are saved. Run /reload to apply them to new subagents.",
        "info",
      );
  } catch {
    ctx.ui.notify(
      "Could not open Subagents profile settings. Run /reload and try again; inspect the Pi logs if the problem continues.",
      "error",
    );
  } finally {
    requestWorkspaceRender = undefined;
    modelRefreshController.abort();
  }
}

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  pi.registerCommand("subagents", {
    description: "Open the subagent fleet or configure profiles",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const choices = [
        { value: "profiles", label: "profiles", description: "Configure profile routes" },
        {
          value: "profiles session",
          label: "profiles session",
          description: "Configure temporary routes for this session",
        },
        {
          value: "profiles global",
          label: "profiles global",
          description: "Configure global profile routes",
        },
        {
          value: "profiles project",
          label: "profiles project",
          description: "Configure trusted-project profile routes",
        },
      ];
      const matches = choices.filter((choice) => choice.value.startsWith(query));
      return matches.length > 0 ? matches : null;
    },
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
