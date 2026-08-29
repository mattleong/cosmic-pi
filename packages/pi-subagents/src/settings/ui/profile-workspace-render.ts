import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  managerNoticeGlyph,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "pi-cosmic-ui/manager";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import { MAX_PROFILE_CANDIDATES } from "../../profiles/model.ts";

import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS, sameProfileCandidates, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type {
  ProfileRouteDraft,
  ProfileSettingsInspection,
  ProfileSettingsScope,
  ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import { profileWorkspaceTargetLabel } from "../profile-route-editor.ts";
import {
  candidateEffortLabel,
  candidateFastModeApplied,
  candidateFieldRows,
  draftKindLabel,
  effectiveProfileSummary,
  PROFILE_WORKSPACE_SHORTCUTS,
  profileRouteOptionLabel,
  type ProfileWorkspacePane,
} from "./profile-workspace-model.ts";
import type { SettingsSelectKeybindingId } from "./searchable-select-page.ts";

export interface ProfileWorkspaceConfirmation {
  readonly key?: string | undefined;
  readonly title: string;
  readonly detail: string;
  readonly preview?: ReadonlyArray<string> | undefined;
}

export interface ProfileWorkspaceRenderState {
  readonly inspection: ProfileSettingsInspection;
  readonly target: ProfileWorkspaceTarget;
  readonly scope: ProfileSettingsScope;
  readonly projectTrusted: boolean;
  readonly parentEffort: SubagentEffort;
  readonly parentModel?: string | undefined;
  readonly pane: ProfileWorkspacePane;
  readonly profileIndex: number;
  readonly candidateIndex: number;
  readonly fieldIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly busy: boolean;
  readonly cancellableBusy: boolean;
  readonly reloadRequired: boolean;
  readonly alternateHelp?: boolean | undefined;
  readonly message?:
    | { readonly kind: "info" | "success" | "warning" | "error"; readonly text: string }
    | undefined;
  readonly pendingConfirmation?: ProfileWorkspaceConfirmation | undefined;
}

export interface ProfileWorkspaceRenderOptions {
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
}

const padToWidth = (text: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  const truncated = truncateToWidth(text, safeWidth, "");
  return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
};

const selectedProfile = (state: ProfileWorkspaceRenderState) =>
  PROFILE_IDS[state.profileIndex] ?? PROFILE_IDS[0];

const scopeNumber = (scope: ProfileSettingsScope): number =>
  scope === "session" ? 1 : scope === "project" ? 2 : 3;

const scopeName = (scope: ProfileSettingsScope): string =>
  scope === "session" ? "Session" : scope === "project" ? "Project" : "Global";

const scopeSelectorLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
): ReadonlyArray<string> => [
  "Scope    1 Session · 2 Project · 3 Global",
  `Current  ${theme.fg("accent", theme.bold(`${scopeNumber(state.scope)} ${scopeName(state.scope)}`))} · ${profileWorkspaceTargetLabel(state.target)} · s Sets${state.projectTrusted ? "" : " · Project unavailable (trust required)"}`,
];

const scopeLine = (state: ProfileWorkspaceRenderState, theme: Theme): string => {
  const effect =
    state.scope === "session"
      ? "temporary override · applies now"
      : state.scope === "global"
        ? "omitted Global profiles use Built-in · applies after reload"
        : "Project declarations override profile by profile; omitted profiles inherit Global · applies after reload";
  return `Editing  ${theme.fg("accent", theme.bold(profileWorkspaceTargetLabel(state.target)))} · ${effect}`;
};

const wrapped = (value: string, width: number): ReadonlyArray<string> =>
  wrapTextWithAnsi(value, Math.max(1, width));

const sessionOverrideActive = (state: ProfileWorkspaceRenderState): boolean =>
  state.scope !== "session" &&
  state.inspection.session.overrides[selectedProfile(state)] !== undefined;

const persistentRouteDiffersFromActiveBase = (state: ProfileWorkspaceRenderState): boolean => {
  const profile = selectedProfile(state);
  return (
    state.inspection.config.profileSources[profile] !==
      state.inspection.session.baseConfig.profileSources[profile] ||
    !sameProfileCandidates(
      state.inspection.config.profiles[profile].candidates,
      state.inspection.session.baseConfig.profiles[profile].candidates,
    )
  );
};

const projectOverrideActive = (state: ProfileWorkspaceRenderState): boolean => {
  if (state.scope !== "global") return false;
  const project = state.inspection.project;
  const profile = selectedProfile(state);
  const setName = project?.file.defaultProfileSet;
  if (!project || !setName) return project?.invalidDefaultProfileSet ?? false;
  const profileSet = project.file.profileSets?.[setName];
  return Boolean(
    project.invalidDefaultProfileSet ||
    project.invalidProfileSetRoutes[setName]?.includes(profile) ||
    Object.prototype.hasOwnProperty.call(profileSet?.profiles ?? {}, profile),
  );
};

const routeOptionWording = (value: string, candidateIndex: number): string =>
  value
    .replace(
      /Remove candidate \d+/gi,
      `Remove route option · ${profileRouteOptionLabel(candidateIndex)}`,
    )
    .replace(/\bcandidates\b/gi, "route options")
    .replace(/\bcandidate\b/gi, "route option");

const commonNotices = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  const lines: string[] = [];
  if (state.scope !== "session" && persistentRouteDiffersFromActiveBase(state)) {
    lines.push(
      ...wrapped(
        theme.fg(
          "warning",
          `! Saved ${selectedProfile(state)} settings differ from the active session base. Effective shows the active route; reload applies the saved route.`,
        ),
        width,
      ),
      "",
    );
  }
  if (sessionOverrideActive(state)) {
    lines.push(
      ...wrapped(
        theme.fg(
          "warning",
          `! Session override active for ${selectedProfile(state)}; persistent edits are saved but remain shadowed. Open /subagents profiles session to edit or clear it.`,
        ),
        width,
      ),
      "",
    );
  }
  if (projectOverrideActive(state)) {
    lines.push(
      ...wrapped(
        theme.fg(
          "warning",
          `! Project declarations override Global profile by profile. Omitted Project profiles inherit Global. This Global edit is shadowed only for ${selectedProfile(state)}; use s Sets to edit the Project declaration.`,
        ),
        width,
      ),
      "",
    );
  }
  if (state.pendingConfirmation) {
    lines.push(
      ...wrapped(
        theme.fg(
          "warning",
          theme.bold(
            `Confirm · ${routeOptionWording(state.pendingConfirmation.title, state.candidateIndex)}`,
          ),
        ),
        width,
      ),
      ...wrapped(
        theme.fg(
          "warning",
          routeOptionWording(state.pendingConfirmation.detail, state.candidateIndex),
        ),
        width,
      ),
      ...(state.pendingConfirmation.preview ?? []).flatMap((line) =>
        wrapped(theme.fg("toolOutput", routeOptionWording(line, state.candidateIndex)), width),
      ),
      ...wrapped(theme.fg("warning", "Enter confirms · Esc cancels"), width),
      "",
    );
  } else if (state.message) {
    const color =
      state.message.kind === "error"
        ? "error"
        : state.message.kind === "warning"
          ? "warning"
          : state.message.kind === "success"
            ? "success"
            : "muted";
    lines.push(
      ...wrapped(
        theme.fg(
          color,
          `${managerNoticeGlyph(state.message.kind)} ${routeOptionWording(state.message.text, state.candidateIndex)}`,
        ),
        width,
      ),
      "",
    );
  }
  return lines;
};

const windowLabel = (start: number, visible: number, total: number): string => {
  if (total <= 0) return "";
  const end = Math.min(total, start + visible);
  const range = total === 1 ? "1 of 1" : `${start + 1}–${end} of ${total}`;
  return ` · ${range}${start > 0 ? " · ↑ more" : ""}${end < total ? " · ↓ more" : ""}`;
};

const boundedMiddle = (value: string, maximum: number): string => {
  if (maximum <= 0) return "";
  if (visibleWidth(value) <= maximum) return value;
  if (maximum === 1) return "…";
  const characters = [...value];
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  const right = Math.max(0, maximum - left - 1);
  return `${characters.slice(0, left).join("")}…${right > 0 ? characters.slice(-right).join("") : ""}`;
};

const windowStart = (length: number, selected: number, visibleCount: number): number =>
  Math.max(
    0,
    Math.min(Math.max(0, length - visibleCount), selected - Math.floor(visibleCount / 2)),
  );

const candidateSummary = (
  profile: ProfileId,
  candidate: ProfileRouteDraft["candidates"][number],
  index: number,
  maximum: number,
  parentEffort: SubagentEffort,
  parentModel?: string | undefined,
): string => {
  const optionLabel = profileRouteOptionLabel(index);
  const prefix = `${optionLabel.padEnd(10)} · ${candidate.host}/${candidate.runtime} · `;
  const lifecycle = candidate.closeOnReport ? "close" : "retain";
  const effort = candidateEffortLabel(profile, candidate, parentEffort);
  const fast = candidateFastModeApplied(candidate, parentModel) ? " ⚡" : "";
  const modelSuffix = `:${effort}${fast}`;
  const suffix = ` · ${candidate.context} · ${candidate.writeIntent} · ${lifecycle}`;
  const modelWidth = Math.max(
    4,
    maximum - visibleWidth(prefix) - visibleWidth(modelSuffix) - visibleWidth(suffix),
  );
  return truncateToWidth(
    `${prefix}${boundedMiddle(candidate.model, modelWidth)}${modelSuffix}${suffix}`,
    maximum,
  );
};

const routeActions = (state: ProfileWorkspaceRenderState) => {
  const count = state.draft.candidates.length;
  return {
    add: count < MAX_PROFILE_CANDIDATES,
    clone: count > 0 && count < MAX_PROFILE_CANDIDATES,
    moveUp: count > 1 && state.candidateIndex > 0,
    moveDown: count > 1 && state.candidateIndex < count - 1,
    remove: count > 0,
    disable: state.draft.kind !== "disabled",
    reset: !(
      (state.scope === "global" && state.draft.kind === "reset") ||
      (state.scope !== "global" && state.draft.kind === "inherit")
    ),
  };
};

const profilesPage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
  confirmKey: string,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const actions = routeActions(state);
  const notices = commonNotices(state, theme, width);
  const visibleCount = Math.max(1, availableHeight - 11 - notices.length);
  const start = windowStart(PROFILE_IDS.length, state.profileIndex, visibleCount);
  const visibleProfiles = PROFILE_IDS.slice(start, start + visibleCount);
  return [
    theme.fg(
      "accent",
      theme.bold(`Profiles${windowLabel(start, visibleProfiles.length, PROFILE_IDS.length)}`),
    ),
    "Choose a profile to view or edit. Omitting a profile uses generalist.",
    "Effective source  [S] Session > [P] Project > [G] Global > [B] Built-in",
    ...scopeSelectorLines(state, theme),
    "",
    ...notices,
    ...visibleProfiles.map((entry, offset) => {
      const index = start + offset;
      const marker = index === state.profileIndex ? ">" : " ";
      const fallback = entry === "generalist" ? "when omitted" : "";
      return `${marker} ${entry.padEnd(11)} ${fallback.padEnd(17)} ${effectiveProfileSummary(state.inspection, entry, state.parentEffort, state.parentModel)}`;
    }),
    "",
    theme.fg("muted", "Actions"),
    `  ${confirmKey.padEnd(6)} Edit ${profile}`,
    "  /      Search profiles",
    "  s      Sets",
    ...(actions.reset
      ? [
          `  i      Reset ${profile} ${state.scope === "global" ? "to built-in" : state.scope === "project" ? "to inherit global" : "to active config"}`,
        ]
      : []),
    ...(state.scope === "session" && Object.keys(state.inspection.session.overrides).length > 0
      ? ["  X      Clear all session overrides"]
      : []),
  ];
};

const routePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
  confirmKey: string,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const effective = state.inspection.session.effectiveConfig.profiles[profile];
  const candidates = state.draft.candidates;
  const notices = commonNotices(state, theme, width);
  const hasPreview =
    !projectOverrideActive(state) && !sameProfileCandidates(effective.candidates, candidates);
  const reserved = 16 + (hasPreview ? 1 : 0) + notices.length;
  const visibleCount = Math.max(1, availableHeight - reserved);
  const start = windowStart(candidates.length, state.candidateIndex, visibleCount);
  const visible = candidates.slice(start, start + visibleCount);
  const rows =
    visible.length === 0
      ? [
          state.draft.kind === "invalid"
            ? `  ${managerNoticeGlyph("error")} Invalid declaration · route fails closed`
            : "  — No route options · route is disabled",
        ]
      : visible.map((candidate, offset) => {
          const index = start + offset;
          return `${index === state.candidateIndex ? ">" : " "} ${candidateSummary(profile, candidate, index, Math.max(1, width - 2), state.parentEffort, state.parentModel)}`;
        });
  const actions = routeActions(state);
  return [
    theme.fg("accent", theme.bold("Routing order")),
    `${profile} · ${PROFILE_DEFINITIONS[profile].description}`,
    scopeLine(state, theme),
    `Effective  ${effectiveProfileSummary(state.inspection, profile, state.parentEffort, state.parentModel)}`,
    `Editing    ${state.scope} · ${draftKindLabel(state.draft, state.scope)}`,
    ...(hasPreview
      ? [
          `Preview    ${candidates.length} route option${candidates.length === 1 ? "" : "s"} after this scope`,
        ]
      : []),
    "",
    ...notices,
    theme.fg("muted", `Route options${windowLabel(start, visible.length, candidates.length)}`),
    ...rows,
    "",
    theme.fg("muted", "Actions"),
    ...(candidates.length > 0 ? [`  ${confirmKey.padEnd(6)} Configure selected option`] : []),
    ...(actions.add ? ["  a      Add fallback"] : []),
    ...(actions.clone ? ["  c      Clone fallback"] : []),
    ...(actions.moveDown ? ["  J      Move selected down"] : []),
    ...(actions.moveUp ? ["  K      Move selected up"] : []),
    ...(actions.remove ? ["  x      Remove route option"] : []),
    ...(actions.disable ? ["  d      Disable route"] : []),
    ...(actions.reset
      ? [
          `  i      Reset ${profile} ${state.scope === "global" ? "to built-in" : state.scope === "project" ? "to inherit global" : "to active config"}`,
        ]
      : []),
  ];
};

const candidatePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
  confirmKey: string,
  cancelKey: string,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  const optionLabel = profileRouteOptionLabel(state.candidateIndex);
  const notices = commonNotices(state, theme, width);
  const fields = candidate
    ? candidateFieldRows(candidate, profile, state.parentEffort, state.parentModel)
    : [];
  const visibleCount = Math.max(1, availableHeight - 9 - notices.length);
  const start = windowStart(fields.length, state.fieldIndex, visibleCount);
  // The label column is sized from the actual field labels so a long label like
  // "OpenAI fast mode" and the trailing action survive narrow widths intact.
  const labelWidth = fields.reduce((widest, row) => Math.max(widest, visibleWidth(row.label)), 0);
  const rows = candidate
    ? fields.slice(start, start + visibleCount).map((row, offset) => {
        const index = start + offset;
        const marker = index === state.fieldIndex ? ">" : " ";
        const action = row.fixed ? "fixed by policy" : `${confirmKey} to choose`;
        const compactAction = row.fixed ? "fixed" : "edit";
        const showAction = width >= 46;
        const actionLabel = showAction ? action : compactAction;
        const valueWidth = Math.max(1, width - labelWidth - 6 - actionLabel.length);
        const value = boundedMiddle(row.value, valueWidth);
        return `${marker} ${row.label.padEnd(labelWidth)} ${value.padEnd(valueWidth)} · ${actionLabel}`;
      })
    : ["No route option exists. Return to the routing order and add one."];
  return [
    theme.fg("accent", theme.bold(`${profile} › ${optionLabel}`)),
    PROFILE_DEFINITIONS[profile].description,
    scopeLine(state, theme),
    "",
    ...notices,
    theme.fg(
      "muted",
      `Option settings${windowLabel(start, Math.min(visibleCount, fields.length), fields.length)}`,
    ),
    ...rows,
    "",
    theme.fg("muted", "Actions"),
    `  ${confirmKey.padEnd(6)} Choose value for selected field`,
    `  ${cancelKey.padEnd(6)} Back to routing order`,
  ];
};

const helpText = (
  state: ProfileWorkspaceRenderState,
  width: number,
  keybindingLabel?: ((id: SettingsSelectKeybindingId, fallback: string) => string) | undefined,
): string => {
  const key = (id: SettingsSelectKeybindingId, fallback: string): string =>
    filterReservedKeyLabel(
      keybindingLabel?.(id, fallback) || fallback,
      PROFILE_WORKSPACE_SHORTCUTS,
      fallback,
    );
  const configuredNavigation = keybindingLabel
    ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
    : undefined;
  const navigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
  const enter = key("tui.select.confirm", "Enter");
  const escape = key("tui.select.cancel", "Esc");
  if (state.pendingConfirmation)
    return renderResponsiveManagerFooter(Math.max(0, width), [["Enter confirms", "Esc cancels"]]);
  if (state.busy)
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        state.cancellableBusy ? "Loading model catalog…" : "Saving or reloading…",
        state.cancellableBusy ? `${escape} Cancel` : `${escape} Wait`,
      ],
    ]);
  if (state.alternateHelp)
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Move · C-u/d Half · PgUp/PgDn Page · gg/G Ends`,
        `h/l Panes · Tab/⇧Tab Pages`,
        `? Back · ${escape}/q Close`,
      ],
      [`${navigation} · C-u/d · PgUp/PgDn · gg/G`, `h/l · Tab`, `? Back · ${escape}/q`],
      [`? Back · ${escape}/q`],
    ]);
  if (state.pane === "profiles") {
    const canReset = routeActions(state).reset;
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · C-u/d · gg/G`,
        `${enter}/l Edit · / Search`,
        "1 Session · 2 Project · 3 Global · s Sets",
        `${canReset ? "i Reset · " : ""}${state.reloadRequired ? "r Reload · " : ""}${escape} Close`,
      ],
      [
        `${navigation} · ${enter}/l · / Search`,
        `s Sets · 1/2/3 Scope${canReset ? " · i Reset" : ""}`,
        `${state.reloadRequired ? "r Reload · " : ""}${escape} Close`,
      ],
    ]);
  }
  if (state.pane === "candidates") {
    const actions = routeActions(state);
    const actionLabels = [
      actions.add ? "a Add fallback" : undefined,
      actions.clone ? "c Clone fallback" : undefined,
      actions.moveDown ? "J Down" : undefined,
      actions.moveUp ? "K Up" : undefined,
      actions.remove ? "x Remove route option" : undefined,
      actions.disable ? "d Disable" : undefined,
      actions.reset ? "i Reset" : undefined,
    ].filter((label): label is string => label !== undefined);
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · C-u/d · gg/G · ${enter}/l Configure`,
        actionLabels.join(" · ") || "No route changes available",
        `${escape} Profiles · Tab/⇧Tab Pages · ? Help`,
        state.reloadRequired ? "r Reload" : "",
      ],
      [
        `${navigation} · ${enter}/l · ${escape}`,
        actionLabels.join(" · ") || "No changes",
        state.reloadRequired ? "r Reload" : "",
      ],
    ]);
  }
  return renderResponsiveManagerFooter(Math.max(0, width), [
    [
      `${navigation} Field · C-u/d · gg/G · ${enter}/l Choose`,
      `h/${escape} Routing order · ⇧Tab Back · ? Help`,
      state.reloadRequired ? "r Reload" : "",
    ],
    [
      `${navigation} Field · ${enter}/l Choose · ${escape} Back`,
      state.reloadRequired ? "r Reload" : "",
    ],
  ]);
};

const compactWorkspacePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  height: number,
  width: number,
  confirmKey: string,
  cancelKey: string,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  const optionLabel = profileRouteOptionLabel(state.candidateIndex);
  const field = candidate
    ? candidateFieldRows(candidate, profile, state.parentEffort, state.parentModel)[
        state.fieldIndex
      ]
    : undefined;
  const heading =
    state.pane === "profiles"
      ? `Profiles · ${state.profileIndex + 1}/${PROFILE_IDS.length}`
      : state.pane === "candidates"
        ? `Routing order · ${profile} · ${state.draft.candidates.length === 0 ? 0 : state.candidateIndex + 1}/${state.draft.candidates.length}`
        : `${profile} · ${optionLabel}`;
  const selected =
    state.pane === "profiles"
      ? `${profile}${profile === "generalist" ? " · when omitted" : ""} · ${effectiveProfileSummary(state.inspection, profile, state.parentEffort, state.parentModel)}`
      : state.pane === "candidates"
        ? candidate
          ? candidateSummary(
              profile,
              candidate,
              state.candidateIndex,
              Math.max(1, width),
              state.parentEffort,
              state.parentModel,
            )
          : state.draft.kind === "invalid"
            ? `${managerNoticeGlyph("error")} Invalid declaration · route fails closed`
            : "— No route options · route disabled"
        : field
          ? `${field.label}: ${boundedMiddle(field.value, Math.max(1, width - field.label.length - 12))} · ${field.fixed ? "fixed" : "edit"}`
          : "No route option · return to routing order";
  const actions = state.pendingConfirmation
    ? "Enter confirms · Esc cancels"
    : state.pane === "profiles"
      ? `${confirmKey} edit · ${cancelKey} close · / search`
      : state.pane === "candidates"
        ? state.draft.candidates.length > 0
          ? `${confirmKey} configure · ${cancelKey} profiles · a Add fallback · x Remove route option`
          : `${cancelKey} profiles · a Add fallback`
        : field?.fixed
          ? `Fixed by policy · ${cancelKey} routing order`
          : `${confirmKey} choose · ${cancelKey} routing order`;
  const controls =
    state.pane === "profiles"
      ? `s Sets · 1 Session · 2 Project${state.projectTrusted ? "" : " unavailable"} · 3 Global${state.reloadRequired ? " · r Reload" : ""}`
      : `Editing ${scopeName(state.scope)}${state.reloadRequired ? " · r Reload" : ""}`;
  const status: string[] = [];
  if (state.pendingConfirmation) {
    status.push(
      theme.fg(
        "warning",
        `Confirm · ${routeOptionWording(state.pendingConfirmation.title, state.candidateIndex)} · ${routeOptionWording(state.pendingConfirmation.detail, state.candidateIndex)}`,
      ),
    );
  } else if (state.message) {
    const color =
      state.message.kind === "error"
        ? "error"
        : state.message.kind === "warning"
          ? "warning"
          : state.message.kind === "success"
            ? "success"
            : "muted";
    const shadow = sessionOverrideActive(state)
      ? " · Session override active; use the Session editor to edit or clear it"
      : projectOverrideActive(state)
        ? ` · Global edit shadowed only for ${profile}; omitted Project profiles inherit Global`
        : "";
    status.push(
      theme.fg(color, `${routeOptionWording(state.message.text, state.candidateIndex)}${shadow}`),
    );
  } else if (sessionOverrideActive(state)) {
    status.push(theme.fg("warning", "Session override active · use the Session editor"));
  } else if (projectOverrideActive(state)) {
    status.push(
      theme.fg(
        "warning",
        `Global edit shadowed only for ${profile} · omitted Project profiles inherit Global`,
      ),
    );
  }
  if (height <= 1) return [theme.fg("accent", selected)];
  if (height === 2) return [theme.fg("accent", selected), theme.fg("dim", actions)];
  const context = [
    ...status,
    theme.fg("muted", controls),
    ...(status.length === 0 ? [theme.fg("accent", theme.bold(heading))] : []),
  ];
  return [
    ...context.slice(0, Math.max(0, height - 2)),
    theme.fg("accent", selected),
    theme.fg("dim", actions),
  ];
};

const breadcrumb = (state: ProfileWorkspaceRenderState): string => {
  if (state.pane === "profiles") return "/subagents profiles";
  const profile = selectedProfile(state);
  if (state.pane === "candidates") return `/subagents profiles › ${profile}`;
  return `/subagents profiles › ${profile} › ${profileRouteOptionLabel(state.candidateIndex)}`;
};

const compactBreadcrumb = (state: ProfileWorkspaceRenderState): string => {
  if (state.pane === "profiles") return "/profiles";
  const profile = selectedProfile(state);
  if (state.pane === "candidates") return `/profiles › ${profile}`;
  return `${profile} › ${profileRouteOptionLabel(state.candidateIndex)}`;
};

export const renderProfileWorkspace = (
  state: ProfileWorkspaceRenderState,
  options: ProfileWorkspaceRenderOptions,
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => " ".repeat(width));
  const theme = options.theme;
  const inner = width - 2;
  const sessionOverrides = Object.keys(state.inspection.session.overrides).length;
  const pending = startingSpinnerFrame(0);
  const statusText = state.busy
    ? state.cancellableBusy
      ? `${pending} loading catalog`
      : `${pending} saving/reloading`
    : state.reloadRequired
      ? `${pending} reload required · r Reload`
      : sessionOverrides > 0
        ? `${sessionOverrides} session override${sessionOverrides === 1 ? "" : "s"} · applies now`
        : "ready";
  const status = theme.fg(
    state.busy || state.reloadRequired ? "warning" : sessionOverrides > 0 ? "accent" : "muted",
    statusText,
  );
  const breadcrumbWidth = Math.max(1, inner - visibleWidth(status) - 5);
  const fullBreadcrumb = breadcrumb(state);
  const titleBreadcrumb =
    visibleWidth(fullBreadcrumb) <= breadcrumbWidth ? fullBreadcrumb : compactBreadcrumb(state);
  const titleRaw = ` ${boundedMiddle(titleBreadcrumb, breadcrumbWidth)} · ${status} `;
  const title = truncateToWidth(titleRaw, inner, "");
  const top = `${theme.fg("borderAccent", "╭")}${title}${theme.fg(
    "borderAccent",
    `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`,
  )}`;
  if (height === 1) return [truncateToWidth(top, width, "")];
  const key = (id: SettingsSelectKeybindingId, fallback: string): string =>
    options.keybindingLabel?.(id, fallback) || fallback;
  const confirmKey = key("tui.select.confirm", "Enter");
  const cancelKey = key("tui.select.cancel", "Esc");
  const footer = truncateToWidth(helpText(state, inner, options.keybindingLabel), inner, "");
  const bottom = `${theme.fg("borderAccent", "╰")}${theme.fg(
    "borderAccent",
    "─".repeat(Math.max(0, inner - visibleWidth(footer))),
  )}${footer}${theme.fg("borderAccent", "╯")}`;
  const bodyHeight = Math.max(0, height - 2);
  const noticeRows = commonNotices(state, theme, inner).length;
  const minimumSelectedRow =
    state.pane === "profiles"
      ? 7 + noticeRows
      : state.pane === "candidates"
        ? 8 + noticeRows
        : 6 + noticeRows;
  const rows =
    bodyHeight <= 6 || bodyHeight < minimumSelectedRow
      ? compactWorkspacePage(state, theme, bodyHeight, inner, confirmKey, cancelKey)
      : state.pane === "profiles"
        ? profilesPage(state, theme, bodyHeight, inner, confirmKey)
        : state.pane === "candidates"
          ? routePage(state, theme, bodyHeight, inner, confirmKey)
          : candidatePage(state, theme, bodyHeight, inner, confirmKey, cancelKey);
  const body = rows
    .slice(0, bodyHeight)
    .map(
      (line) =>
        `${theme.fg("borderAccent", "│")}${padToWidth(line, inner)}${theme.fg("borderAccent", "│")}`,
    );
  while (body.length < bodyHeight)
    body.push(
      `${theme.fg("borderAccent", "│")}${" ".repeat(inner)}${theme.fg("borderAccent", "│")}`,
    );
  return [truncateToWidth(top, width, ""), ...body, truncateToWidth(bottom, width, "")];
};
