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
  ) => Promise<ReadonlyArray<NativeRuntimeModel>>;
}

const report = (ctx: ExtensionCommandContext, operation: Promise<void>) =>
  void operation.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Subagent operation failed.";
    ctx.ui.notify(message, "error");
  });

async function openFleetManager(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    if (ctx.hasUI) ctx.ui.notify("/subagents requires interactive TUI mode.", "warning");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      let unsubscribe = () => {};
      const promptMessage = (id: string, waiting: boolean) => {
        void ctx.ui
          .input(waiting ? "Reply to subagent" : "Message subagent", "Enter guidance")
          .then((message) => {
            if (!message?.trim()) return;
            report(
              ctx,
              waiting ? actions.reply(id, message.trim()) : actions.send(id, message.trim()),
            );
          });
      };
      const promptResume = (id: string) => {
        void ctx.ui.input("Resume subagent", "Optional continuation message").then((message) => {
          if (message === undefined) return;
          report(ctx, actions.resume(id, message.trim() || undefined));
        });
      };
      const promptRename = (id: string) => {
        void ctx.ui.input("Rename subagent", "New display name").then((name) => {
          if (!name?.trim()) return;
          report(ctx, actions.rename(id, name.trim()));
        });
      };
      const manager = new SubagentFleetComponent({
        theme,
        getProjection: bridge.get,
        getHeight: () => tui.terminal.rows,
        getNow: synchronousNow,
        matchesKeybinding: (data, id) => keybindings.matches(data, id),
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        actions: {
          stop: (id) => report(ctx, actions.stop(id)),
          interrupt: (id) => report(ctx, actions.interrupt(id)),
          resume: promptResume,
          message: promptMessage,
          rename: promptRename,
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
  const firstPiModel = availableModels[0]
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
        ...(firstPiModel ? { piModel: firstPiModel } : {}),
        getHeight: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        matchesKeybinding: (data, id) => keybindings.matches(data, id),
        close: done,
        saveDraft,
        loadModelPicker: (profile, candidateIndex, candidate) =>
          loadCandidateModelPicker(ctx, {
            profile,
            candidateIndex,
            candidate,
            listNativeModels: actions.listNativeModels,
          }),
        supportedPiEfforts: (candidate) => supportedPiEfforts(ctx, candidate),
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
