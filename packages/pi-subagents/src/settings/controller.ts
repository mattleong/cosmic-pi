// Pi command and custom-UI handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { synchronousNow } from "../boundary/native-clock.ts";
import { startHostUiTicker, type SubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import type {
  SubagentConfigInspection,
  SubagentConfigScope,
  SubagentProfilePatch,
} from "../config/store.ts";
import type { ProfileCandidate, ProfileId } from "../profiles/model.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import { isActiveRunState, type SubagentEffort } from "../run/model.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import { declaredRouteForDraft, type ProfileRouteDraft } from "./profile-route-editor.ts";
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
  readonly inspectProfiles: (projectTrusted: boolean) => Promise<SubagentConfigInspection>;
  readonly patchProfile: (patch: SubagentProfilePatch) => Promise<void>;
  readonly listNativeModels: (
    runtime: LocalCliRuntime,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<NativeRuntimeModel>>;
}

const formatKeyId = (value: string): string => {
  const labels: Readonly<Record<string, string>> = {
    up: "↑",
    down: "↓",
    enter: "Enter",
    escape: "Esc",
    pageUp: "PgUp",
    pageDown: "PgDn",
    tab: "Tab",
  };
  const parts = value.split("+");
  const base = parts.pop() ?? value;
  const modifiers = parts
    .map((part) => (part === "ctrl" ? "C-" : part === "shift" ? "⇧" : part === "alt" ? "A-" : "⌘"))
    .join("");
  const key = labels[base] ?? (base.length === 1 ? base.toUpperCase() : base);
  return `${modifiers}${key}`;
};

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
          typeof keybindings.getKeys === "function"
            ? keybindings.getKeys(id).map(formatKeyId).join("/") || fallback
            : fallback,
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

const supportedPiEfforts = (
  ctx: ExtensionCommandContext,
  candidate: ProfileCandidate,
): ReadonlyArray<SubagentEffort> | undefined => {
  if (candidate.runtime !== "pi") return undefined;
  const parentModel = ctx.model
    ? ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
    : undefined;
  const choices = createProfileModelChoices({
    models: ctx.modelRegistry.getAvailable(),
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

const fastModeAvailable = (ctx: ExtensionCommandContext, candidate: ProfileCandidate): boolean => {
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
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
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
  let inspection: SubagentConfigInspection;
  try {
    inspection = await actions.inspectProfiles(projectTrusted);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Could not inspect profile settings.",
      "error",
    );
    return;
  }

  const availableModels = ctx.modelRegistry.getAvailable();
  const preferredPiModel = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : availableModels[0]
      ? `${availableModels[0].provider}/${availableModels[0].id}`
      : undefined;
  const saveDraft = async (
    scope: SubagentConfigScope,
    profile: ProfileId,
    draft: ProfileRouteDraft,
  ): Promise<ProfileWorkspaceSaveResult> => {
    const declaration = declaredRouteForDraft(draft);
    if (!declaration.valid) throw new Error(declaration.error);
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
    try {
      inspection = await actions.inspectProfiles(isProjectTrusted(ctx));
      return { inspection };
    } catch {
      return {
        refreshError:
          "Profile settings were saved, but the workspace could not refresh. Reload or reopen /subagents profiles before editing again.",
      };
    }
  };

  const reloadRequired = await ctx.ui.custom<boolean>(
    (tui, theme, keybindings, done) =>
      new ProfileWorkspaceComponent({
        theme,
        inspection,
        projectTrusted,
        ...(preferredPiModel ? { piModel: preferredPiModel } : {}),
        getHeight: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        matchesKeybinding: (data, id) => keybindings.matches(data, id),
        keybindingLabel: (id, fallback) =>
          typeof keybindings.getKeys === "function"
            ? keybindings.getKeys(id).map(formatKeyId).join("/") || fallback
            : fallback,
        close: done,
        saveDraft,
        loadModelPicker: (profile, candidateIndex, candidate, signal) =>
          loadCandidateModelPicker(ctx, {
            profile,
            candidateIndex,
            candidate,
            listNativeModels: actions.listNativeModels,
            ...(signal ? { signal } : {}),
          }),
        supportedPiEfforts: (candidate) => supportedPiEfforts(ctx, candidate),
        fastModeAvailable: (candidate) => fastModeAvailable(ctx, candidate),
        reload: () => requestProfileReload(ctx, bridge),
      }),
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
  );
  if (reloadRequired)
    ctx.ui.notify("Profile changes are saved. Run /reload to apply them to new subagents.", "info");
}

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  pi.registerCommand("subagents", {
    description: "Open the subagent fleet or configure profiles",
    getArgumentCompletions: (prefix) =>
      "profiles".startsWith(prefix.trim().toLowerCase())
        ? [{ value: "profiles", label: "profiles", description: "Configure profile routes" }]
        : null,
    handler: (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) return openFleetManager(ctx, bridge, actions);
      if (command === "profiles") return openProfileSettings(ctx, bridge, actions);
      ctx.ui.notify(
        "Usage: /subagents [profiles] — omit arguments for the fleet inspector.",
        "error",
      );
      return Promise.resolve();
    },
  });
}
