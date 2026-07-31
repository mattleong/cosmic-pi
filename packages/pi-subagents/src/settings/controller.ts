// Pi command and custom-UI handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { synchronousNow } from "../boundary/native-clock.ts";
import { startHostUiTicker, type SubagentProjectionBridge } from "../boundary/host-ui.ts";
import { MAX_PROFILE_CANDIDATES } from "../config/schema.ts";
import type {
  SubagentConfigInspection,
  SubagentConfigScope,
  SubagentProfilePatch,
} from "../config/store.ts";
import {
  PROFILE_IDS,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import { isActiveRunState } from "../run/model.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";
import {
  addRouteCandidate,
  candidateMenuSummary,
  completeRouteSummary,
  declaredRouteForDraft,
  defaultRouteCandidate,
  disableRouteDraft,
  duplicateRouteCandidate,
  inheritProjectDraft,
  loadProfileRouteDraft,
  moveRouteCandidate,
  removeRouteCandidate,
  replaceRouteCandidate,
  resetGlobalDraft,
  type ProfileRouteDraft,
} from "./profile-route-editor.ts";
import { editProfileCandidate } from "./ui/candidate-editor.ts";

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

const globalProfileRoute = (
  inspection: SubagentConfigInspection,
  profile: ProfileId,
): { readonly route: ProfileRoute; readonly source: ProfileRouteSource } => {
  if (inspection.global.invalidProfileRoutes.includes(profile))
    return { route: { candidates: [] }, source: "global-invalid" };
  const declared = inspection.global.file.profiles?.[profile];
  if (declared === undefined)
    return {
      route: loadProfileRouteDraft(inspection, "global", profile),
      source: "builtin",
    };
  return {
    route: {
      candidates:
        declared === "disabled"
          ? []
          : loadProfileRouteDraft(inspection, "global", profile).candidates,
    },
    source: "global",
  };
};

const profileSummary = (
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): string => {
  const { route, source: routeSource } =
    scope === "global"
      ? globalProfileRoute(inspection, profile)
      : {
          route: inspection.config.profiles[profile],
          source: inspection.config.profileSources[profile],
        };
  const source = routeSource.replace("-invalid", " invalid");
  if (routeSource.endsWith("-invalid")) return `${profile} · ${source} · Fail-closed · replaceable`;
  if (route.candidates.length === 0) return `${profile} · ${source} · Disabled`;
  const first = route.candidates[0];
  return `${profile} · ${source} · ${route.candidates.length} candidate${route.candidates.length === 1 ? "" : "s"} · ${first?.host}/${first?.runtime}/${boundedMiddle(first?.model ?? "", 56)} · ${first?.effort} · ${first?.context} · ${first?.writeIntent}`;
};

const chooseScope = async (
  ctx: ExtensionCommandContext,
  inspection: SubagentConfigInspection,
  projectTrusted: boolean,
): Promise<SubagentConfigScope | undefined> => {
  const global = `Global · ${boundedMiddle(inspection.config.globalConfigPath)}`;
  const project = `Project · ${boundedMiddle(inspection.config.projectConfigPath)}`;
  const options = projectTrusted ? [global, project] : [global];
  const selected = await ctx.ui.select(
    projectTrusted
      ? "Subagent profile settings · choose scope · esc close"
      : "Subagent profile settings · choose scope · Project unavailable while untrusted · esc close",
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

const ADD_CANDIDATE = "Add candidate";
const DISABLE_ROUTE = "Disable route";
const SAVE_ROUTE = "Save route";
const CANCEL_ROUTE = "Cancel · discard without writing";
const EDIT_CANDIDATE = "Edit candidate";
const MOVE_UP = "Move up";
const MOVE_DOWN = "Move down";
const DUPLICATE = "Duplicate candidate";
const REMOVE_CANDIDATE = "Remove candidate";
const BACK_TO_ROUTE = "Back to route";

const boundedMiddle = (value: string, maximum = 88): string => {
  if (value.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${value.slice(0, left)}…${value.slice(value.length - (maximum - left - 1))}`;
};

const draftStatus = (draft: ProfileRouteDraft): string => {
  if (draft.kind === "invalid") return "Invalid · fail-closed until replaced";
  if (draft.kind === "disabled") return "Disabled";
  if (draft.kind === "reset") return `Built-in route · ${draft.candidates.length} candidate`;
  if (draft.kind === "inherit")
    return `Inherit global · ${draft.candidates.length} candidate${draft.candidates.length === 1 ? "" : "s"}`;
  return `Explicit ordered route · ${draft.candidates.length} candidate${draft.candidates.length === 1 ? "" : "s"}`;
};

async function editCandidateActions(
  ctx: ExtensionCommandContext,
  profile: ProfileId,
  draft: ProfileRouteDraft,
  index: number,
): Promise<ProfileRouteDraft> {
  const candidate = draft.candidates[index];
  if (!candidate) return draft;
  const options = [
    EDIT_CANDIDATE,
    ...(index > 0 ? [MOVE_UP] : []),
    ...(index < draft.candidates.length - 1 ? [MOVE_DOWN] : []),
    ...(draft.candidates.length < MAX_PROFILE_CANDIDATES ? [DUPLICATE] : []),
    REMOVE_CANDIDATE,
    BACK_TO_ROUTE,
  ];
  const selected = await ctx.ui.select(
    `${profile} · ${candidateMenuSummary(candidate, index)} · esc back to route`,
    options,
  );
  if (!selected || selected === BACK_TO_ROUTE) return draft;
  if (selected === EDIT_CANDIDATE) {
    const edited = await editProfileCandidate(ctx, { profile, candidateIndex: index, candidate });
    return edited ? replaceRouteCandidate(draft, index, edited) : draft;
  }
  if (selected === MOVE_UP) return moveRouteCandidate(draft, index, "up");
  if (selected === MOVE_DOWN) return moveRouteCandidate(draft, index, "down");
  if (selected === DUPLICATE) return duplicateRouteCandidate(draft, index) ?? draft;
  const removed = removeRouteCandidate(draft, index);
  if (removed.kind === "disabled")
    ctx.ui.notify("The last candidate was removed; the staged route is now Disabled.", "info");
  return removed;
}

async function editProfile(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
  inspection: SubagentConfigInspection,
  scope: SubagentConfigScope,
  profile: ProfileId,
): Promise<EditProfileResult> {
  const scopePath =
    scope === "global" ? inspection.config.globalConfigPath : inspection.config.projectConfigPath;
  let draft = loadProfileRouteDraft(inspection, scope, profile);
  if (draft.kind === "invalid")
    ctx.ui.notify(
      `${profile}: the declared route in ${scopePath} is invalid and fails closed. Add a valid candidate, disable it, or ${scope === "project" ? "inherit global" : "reset to built-in"}.`,
      "warning",
    );

  while (true) {
    const candidateLabels = draft.candidates.map(candidateMenuSummary);
    const addLabel =
      draft.candidates.length >= MAX_PROFILE_CANDIDATES
        ? `${ADD_CANDIDATE} · maximum ${MAX_PROFILE_CANDIDATES} reached`
        : `${ADD_CANDIDATE} · ${draft.candidates.length}/${MAX_PROFILE_CANDIDATES}`;
    const scopeDefault =
      scope === "global" ? "Reset global to built-in" : "Inherit global (remove project route)";
    const options = [
      ...candidateLabels,
      addLabel,
      DISABLE_ROUTE,
      scopeDefault,
      SAVE_ROUTE,
      CANCEL_ROUTE,
    ];
    const selected = await ctx.ui.select(
      `${profile} · ${draftStatus(draft)} · launch order shown · ${boundedMiddle(scopePath)} · esc cancel`,
      options,
    );
    if (!selected || selected === CANCEL_ROUTE) return "back";
    const candidateIndex = candidateLabels.indexOf(selected);
    if (candidateIndex >= 0) {
      draft = await editCandidateActions(ctx, profile, draft, candidateIndex);
      continue;
    }
    if (selected === addLabel) {
      if (draft.candidates.length >= MAX_PROFILE_CANDIDATES) {
        ctx.ui.notify(
          `A profile route may contain at most ${MAX_PROFILE_CANDIDATES} candidates.`,
          "warning",
        );
        continue;
      }
      const candidate = await editProfileCandidate(ctx, {
        profile,
        candidateIndex: draft.candidates.length,
        candidate: defaultRouteCandidate(profile),
      });
      if (candidate) draft = addRouteCandidate(draft, candidate) ?? draft;
      continue;
    }
    if (selected === DISABLE_ROUTE) {
      draft = disableRouteDraft();
      continue;
    }
    if (selected === scopeDefault) {
      draft =
        scope === "global" ? resetGlobalDraft(profile) : inheritProjectDraft(inspection, profile);
      continue;
    }
    if (selected !== SAVE_ROUTE) continue;

    const declaration = declaredRouteForDraft(draft);
    if (!declaration.valid) {
      ctx.ui.notify(declaration.error, "warning");
      continue;
    }
    const summary = completeRouteSummary(draft, scope);
    if (
      !(await ctx.ui.confirm(
        `Save ${profile} route?`,
        `${summary}\n\nScope: ${scope}\nTarget: ${scopePath}`,
      ))
    )
      continue;
    const expectedDocument =
      scope === "global" ? inspection.globalDocument : inspection.projectDocument;
    try {
      await actions.patchProfile({
        scope,
        profile,
        ...(declaration.route === undefined ? {} : { route: declaration.route }),
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
      const labels = PROFILE_IDS.map((profile) => profileSummary(inspection, scope, profile));
      const selected = await ctx.ui.select(
        `${scope === "global" ? "Global" : "Project"} profiles · ${boundedMiddle(path)} · esc back to scope`,
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

export const _profileSettingsTest = { profileSummary };
