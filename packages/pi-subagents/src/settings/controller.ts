// Pi command and custom-UI handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { synchronousNow } from "../boundary/native-clock.ts";
import { startHostUiTicker, type SubagentProjectionBridge } from "../boundary/host-ui.ts";
import { modelPolicyFor } from "../config/options.ts";
import type {
  SubagentConfigInspection,
  SubagentConfigScope,
  SubagentProfilePatch,
} from "../config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import { PROFILE_IDS, type DeclaredProfileRoute, type ProfileId } from "../profiles/model.ts";
import { isActiveRunState } from "../run/model.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import {
  createProfileModelChoices,
  effortPickerOptions,
  selectProfileModel,
  type ProfileModelChoice,
} from "./ui/model-picker.ts";

export interface FleetManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  readonly send: (id: string, message: string) => Promise<void>;
  readonly reply: (id: string, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
  readonly inspectProfiles: (projectTrusted: boolean) => Promise<SubagentConfigInspection>;
  readonly patchProfile: (patch: SubagentProfilePatch) => Promise<void>;
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
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("/subagents requires interactive TUI mode.", "warning");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
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
      const stopSpinnerTicker = startHostUiTicker(160, () => {
        if (bridge.get().runs.some((run) => run.state === "starting" || run.state === "running"))
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

const declaredAt = (
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): DeclaredProfileRoute | undefined =>
  scope === "global"
    ? inspection.global.file.profiles?.[profile]
    : inspection.project?.file.profiles?.[profile];

const scopeRouteInvalid = (
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): boolean =>
  (scope === "global" ? inspection.global : inspection.project)?.invalidProfileRoutes.includes(
    profile,
  ) ?? false;

/**
 * The selection marked "(current)" reflects only the scope being edited: a malformed
 * declared route fails closed and gets no current marker, and a project scope without
 * a local declaration is "inherit" even when the inherited route is multi-candidate.
 */
const currentSelectorFor = (
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): string | undefined => {
  if (scopeRouteInvalid(inspection, scope, profile)) return undefined;
  const declared = declaredAt(inspection, scope, profile);
  if (declared === undefined)
    return scope === "project" ? "inherit" : BUILTIN_PROFILE_ROUTES[profile].candidates[0]?.model;
  if (declared === "disabled") return "disabled";
  const candidates = Array.isArray(declared) ? declared : [declared];
  return candidates.length === 1 ? candidates[0]?.model : undefined;
};

const profileSummary = (inspection: SubagentConfigInspection, profile: ProfileId): string => {
  const route = inspection.config.profiles[profile];
  const source = inspection.config.profileSources[profile].replace("-invalid", " invalid");
  if (route.candidates.length === 0) return `${profile} · ${source} · Disabled`;
  if (route.candidates.length > 1)
    return `${profile} · ${source} · Ordered route · ${route.candidates.length} candidates`;
  const candidate = route.candidates[0];
  return `${profile} · ${source} · ${candidate?.model ?? "Disabled"} · ${candidate?.effort ?? ""}`;
};

const selectedEfforts = (
  choices: ReturnType<typeof createProfileModelChoices>,
  choice: ProfileModelChoice,
) => {
  if (choice.kind === "disabled" || choice.kind === "inherit") return [];
  return (
    choices.find((entry) => {
      if (choice.kind === "parent") return entry.choice.kind === "parent";
      return entry.choice.kind === "model" && entry.choice.selector === choice.selector;
    })?.supportedEfforts ?? []
  );
};

const chooseScope = async (
  ctx: ExtensionCommandContext,
  inspection: SubagentConfigInspection,
  projectTrusted: boolean,
): Promise<SubagentConfigScope | undefined> => {
  const global = `Global · ${inspection.config.globalConfigPath}`;
  const project = `Project · ${inspection.config.projectConfigPath}`;
  const options = projectTrusted ? [global, project] : [global];
  const selected = await ctx.ui.select(
    "Subagent profile settings · choose scope · esc close",
    options,
  );
  return selected === global ? "global" : selected === project ? "project" : undefined;
};

async function reloadAfterSave(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
): Promise<void> {
  const active = bridge.get().runs.some((run) => isActiveRunState(run.state));
  const reload = await ctx.ui.confirm(
    "Reload now?",
    active
      ? "Active subagent runs exist. Reloading stops all session-scoped runs. Continue?"
      : "Reload now to apply the saved profile route?",
  );
  if (reload) {
    await ctx.reload();
    return;
  }
  ctx.ui.notify("Profile saved. The change applies on the next /reload.", "info");
}

type EditProfileResult = "back" | "saved";

async function editProfile(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): Promise<EditProfileResult> {
  const declared = declaredAt(inspection, scope, profile);
  const scopePath =
    scope === "global" ? inspection.config.globalConfigPath : inspection.config.projectConfigPath;
  if (Array.isArray(declared) && declared.length > 1) {
    ctx.ui.notify(
      `${profile}: Ordered route · ${declared.length} candidates declared in ${scopePath}. Multi-candidate routes are read-only in this UI; edit that file as JSON.`,
      "warning",
    );
    return "back";
  }
  if (scopeRouteInvalid(inspection, scope, profile))
    ctx.ui.notify(
      `${profile}: the declared route in ${scopePath} is invalid and fails closed. Save a new value${scope === "project" ? " or Inherit global" : ""} to replace it.`,
      "warning",
    );
  const current = currentSelectorFor(inspection, scope, profile);
  const parentModel = ctx.model
    ? ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
    : undefined;
  const choices = createProfileModelChoices({
    models: ctx.modelRegistry.getAvailable(),
    parentModel,
    currentSelector: current,
    projectScope: scope === "project",
    policyFor: (backend, model) => modelPolicyFor(inspection.config, backend, model),
  });

  while (true) {
    const model = await selectProfileModel(ctx, choices, current, {
      profile,
      scope,
      path: scopePath,
    });
    if (!model) return "back";
    if (
      (model.kind === "model" || model.kind === "parent") &&
      model.policy === "discouraged" &&
      !(await ctx.ui.confirm(
        `Discouraged model for ${profile}`,
        "This model is discouraged by Subagents policy. Save it as an explicit profile choice anyway?",
      ))
    )
      continue;

    let route: DeclaredProfileRoute | undefined;
    if (model.kind === "inherit") route = undefined;
    else if (model.kind === "disabled") route = "disabled";
    else {
      const options = effortPickerOptions(selectedEfforts(choices, model));
      const selected = await ctx.ui.select(
        `Profile: ${profile} · Effort for ${model.kind === "parent" ? "Parent model" : model.selector} · esc back to models`,
        options.map((option) => option.label),
      );
      const effort = options.find((option) => option.label === selected)?.effort;
      if (!effort) continue;
      route = { model: model.kind === "parent" ? "parent" : model.selector, effort };
      if (scope === "global" && route.model === "parent" && route.effort === "default")
        route = undefined;
    }

    const summary =
      route === undefined
        ? scope === "project"
          ? "Inherit global"
          : "Built-in parent/default"
        : route === "disabled"
          ? "Disabled"
          : `${route.model} · ${route.effort}`;
    if (
      !(await ctx.ui.confirm(
        `Save ${profile}?`,
        `${summary}\n\nScope: ${scope}\nPath: ${scopePath}`,
      ))
    )
      continue;
    const expectedDocument =
      scope === "global" ? inspection.globalDocument : inspection.projectDocument;
    try {
      await actions.patchProfile({
        scope,
        profile,
        ...(route === undefined ? {} : { route }),
        expectedExists: expectedDocument !== undefined,
        ...(expectedDocument === undefined ? {} : { expectedDocument }),
        projectTrusted: isProjectTrusted(ctx),
      });
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Could not save profile settings.",
        "error",
      );
      return "back";
    }
    await reloadAfterSave(ctx, bridge);
    return "saved";
  }
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
  while (true) {
    const scope = await chooseScope(ctx, inspection, projectTrusted);
    if (!scope) return;
    const path =
      scope === "global" ? inspection.config.globalConfigPath : inspection.config.projectConfigPath;

    while (true) {
      const labels = PROFILE_IDS.map((profile) => profileSummary(inspection, profile));
      const selected = await ctx.ui.select(
        `${scope === "global" ? "Global" : "Project"} profiles · ${path} · esc back to scope`,
        labels,
      );
      const index = selected ? labels.indexOf(selected) : -1;
      const profile = index >= 0 ? PROFILE_IDS[index] : undefined;
      if (!profile) break;
      if ((await editProfile(ctx, bridge, actions, inspection, scope, profile)) === "saved") return;
    }
  }
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

export const _profileSettingsTest = {
  createProfileModelChoices,
  currentSelectorFor,
  effortPickerOptions,
  profileSummary,
};
