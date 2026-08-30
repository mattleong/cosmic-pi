import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  managerNoticeGlyph,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "pi-cosmic-ui/manager";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import { MAX_PROFILE_CANDIDATES } from "../../profiles/model.ts";

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
  effectiveProfilePrimarySummary,
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

const scopeName = (scope: ProfileSettingsScope): string =>
  scope === "session" ? "Session" : scope === "project" ? "Project" : "Global";

const targetContext = (state: ProfileWorkspaceRenderState): string =>
  `${profileWorkspaceTargetLabel(state.target)}${!state.projectTrusted ? " · Project unavailable until trusted" : ""}`;

const targetContextLine = (state: ProfileWorkspaceRenderState, theme: Theme): string =>
  theme.fg("muted", targetContext(state));

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
          `! Saved ${selectedProfile(state)} route is pending reload. Active Primary: ${effectiveProfilePrimarySummary(state.inspection, selectedProfile(state))}.`,
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
          `! Session override shadows saved ${selectedProfile(state)} edits. Switch to Session to edit or clear it.`,
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
          `! Project shadows this Global ${selectedProfile(state)} route. Return to Profiles, then open s Sets to edit it.`,
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
  const prefix = `${optionLabel.padEnd(10)} `;
  const effort = candidateEffortLabel(profile, candidate, parentEffort);
  const fast = candidateFastModeApplied(candidate, parentModel) ? " ⚡" : "";
  const suffix = ` · ${effort}${fast}`;
  const modelWidth = Math.max(4, maximum - visibleWidth(prefix) - visibleWidth(suffix));
  return truncateToWidth(
    `${prefix}${boundedMiddle(candidate.model, modelWidth)}${suffix}`,
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
): ReadonlyArray<string> => {
  const notices = commonNotices(state, theme, width);
  const showTarget =
    profileWorkspaceTargetLabel(state.target) !== scopeName(state.scope) || !state.projectTrusted;
  const visibleCount = Math.max(1, availableHeight - (showTarget ? 4 : 3) - notices.length);
  const start = windowStart(PROFILE_IDS.length, state.profileIndex, visibleCount);
  const visibleProfiles = PROFILE_IDS.slice(start, start + visibleCount);
  return [
    theme.fg(
      "accent",
      theme.bold(`Profiles${windowLabel(start, visibleProfiles.length, PROFILE_IDS.length)}`),
    ),
    ...(showTarget ? [targetContextLine(state, theme)] : []),
    "",
    ...notices,
    ...visibleProfiles.map((entry, offset) => {
      const index = start + offset;
      const marker = index === state.profileIndex ? ">" : " ";
      const label = entry === "generalist" ? `${entry} · default` : entry;
      return `${marker} ${label.padEnd(22)} ${effectiveProfilePrimarySummary(state.inspection, entry)}`;
    }),
  ];
};

const routePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const candidates = state.draft.candidates;
  const notices = commonNotices(state, theme, width);
  const reserved = 8 + notices.length;
  const visibleCount = Math.max(1, availableHeight - reserved);
  const start = windowStart(candidates.length, state.candidateIndex, visibleCount);
  const visible = candidates.slice(start, start + visibleCount);
  const rows =
    visible.length === 0
      ? [
          state.draft.kind === "invalid"
            ? `  ${managerNoticeGlyph("error")} Invalid declaration · route fails closed`
            : "  — Route disabled",
        ]
      : visible.map((candidate, offset) => {
          const index = start + offset;
          return `${index === state.candidateIndex ? ">" : " "} ${candidateSummary(profile, candidate, index, Math.max(1, width - 2), state.parentEffort, state.parentModel)}`;
        });
  const selected = candidates[state.candidateIndex];
  const selectedDetail = selected
    ? `Selected · ${selected.host}/${selected.runtime} · ${selected.context} · ${selected.writeIntent} · ${selected.closeOnReport ? "close after report" : "retain"}`
    : undefined;
  const savedPending = state.scope !== "session" && persistentRouteDiffersFromActiveBase(state);
  return [
    theme.fg("accent", theme.bold(`Routing order · ${profile}${savedPending ? " · saved" : ""}`)),
    targetContextLine(state, theme),
    "",
    ...notices,
    ...rows,
    ...(selectedDetail ? ["", theme.fg("muted", selectedDetail)] : []),
  ];
};

const candidatePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  const optionLabel = profileRouteOptionLabel(state.candidateIndex);
  const notices = commonNotices(state, theme, width);
  const fields = candidate
    ? candidateFieldRows(candidate, profile, state.parentEffort, state.parentModel)
    : [];
  const visibleCount = Math.max(1, availableHeight - 5 - notices.length);
  const start = windowStart(fields.length, state.fieldIndex, visibleCount);
  const labelWidth = fields.reduce((widest, row) => Math.max(widest, visibleWidth(row.label)), 0);
  const rows = candidate
    ? fields.slice(start, start + visibleCount).map((row, offset) => {
        const index = start + offset;
        const marker = index === state.fieldIndex ? ">" : " ";
        const suffix = row.fixed ? " · fixed" : "";
        const valueWidth = Math.max(1, width - labelWidth - 3 - suffix.length);
        const value = boundedMiddle(row.value, valueWidth);
        return `${marker} ${row.label.padEnd(labelWidth)} ${value}${suffix}`;
      })
    : ["No route option exists. Return to the routing order and add one."];
  const savedPending = state.scope !== "session" && persistentRouteDiffersFromActiveBase(state);
  return [
    theme.fg("accent", theme.bold(`${profile} › ${optionLabel}${savedPending ? " · saved" : ""}`)),
    targetContextLine(state, theme),
    "",
    ...notices,
    ...rows,
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
  const actions = routeActions(state);
  const routeActionLabels = [
    actions.add ? "a Add fallback" : undefined,
    actions.clone ? "c Clone" : undefined,
    actions.moveDown ? "J Down" : undefined,
    actions.moveUp ? "K Up" : undefined,
    actions.remove ? "x Remove" : undefined,
    actions.disable ? "d Disable" : undefined,
    actions.reset ? "i Reset" : undefined,
  ].filter((label): label is string => label !== undefined);
  if (state.alternateHelp) {
    if (state.pane === "profiles")
      return renderResponsiveManagerFooter(Math.max(0, width), [
        [
          `${navigation} Select · C-u/d · gg/G · ${enter}/l Edit · / Search`,
          `1/2/3 Scope · s Sets${actions.reset ? " · i Reset" : ""}${state.scope === "session" && Object.keys(state.inspection.session.overrides).length > 0 ? " · X Clear session" : ""}`,
          `${state.reloadRequired ? "r Reload · " : ""}? Less · ${escape} Close`,
        ],
        [
          `${navigation} · ${enter}/l · /`,
          `1/2/3 · s${actions.reset ? " · i" : ""}${state.scope === "session" && Object.keys(state.inspection.session.overrides).length > 0 ? " · X" : ""}`,
          `${state.reloadRequired ? "r · " : ""}? Less · ${escape}`,
        ],
      ]);
    if (state.pane === "candidates")
      return renderResponsiveManagerFooter(Math.max(0, width), [
        [
          `${navigation} Select · C-u/d · gg/G · ${enter}/l Configure`,
          routeActionLabels.join(" · ") || "No route changes",
          `${state.reloadRequired ? "r Reload · " : ""}? Less · ${escape} Profiles`,
        ],
        [
          `${navigation} · ${enter}/l`,
          routeActionLabels.join(" · ") || "No changes",
          `${state.reloadRequired ? "r · " : ""}? · ${escape}`,
        ],
      ]);
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Field · C-u/d · gg/G · ${enter}/l Change`,
        `Tab/⇧Tab Pages · ${state.reloadRequired ? "r Reload · " : ""}? Less · ${escape} Routing`,
      ],
      [`${navigation} · ${enter}/l`, `${state.reloadRequired ? "r · " : ""}? · ${escape}`],
    ]);
  }
  if (state.pane === "profiles")
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · ${enter}/l Edit · / Search`,
        `1/2/3 Scope · ? More · ${escape} Close`,
      ],
      [`${navigation} · ${enter}/l · /`, `1/2/3 · ? More · ${escape}`],
    ]);
  if (state.pane === "candidates")
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · ${enter}/l Configure`,
        `${actions.add ? "a Add fallback · " : ""}? More · ${escape} Profiles`,
      ],
      [`${navigation} · ${enter}/l`, `${actions.add ? "a · " : ""}? · ${escape}`],
    ]);
  return renderResponsiveManagerFooter(Math.max(0, width), [
    [`${navigation} Field · ${enter}/l Change`, `? More · ${escape} Routing order`],
    [`${navigation} · ${enter}/l`, `? · ${escape}`],
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
      ? `${profile}${profile === "generalist" ? " · default" : ""} · ${effectiveProfilePrimarySummary(state.inspection, profile)}`
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
      ? `${confirmKey} edit · / search · ? more · ${cancelKey} close`
      : state.pane === "candidates"
        ? `${confirmKey} configure · a add · ? more · ${cancelKey} back`
        : field?.fixed
          ? `Fixed by policy · ? more · ${cancelKey} back`
          : `${confirmKey} change · ? more · ${cancelKey} back`;
  const controls = targetContext(state);
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
  if (!state.pendingConfirmation && !state.projectTrusted && state.pane === "profiles")
    status.unshift(theme.fg("warning", "Project unavailable until trusted"));
  if (height <= 1) return [status[0] ?? theme.fg("accent", selected)];
  if (height === 2)
    return status.length > 0
      ? [status[0] ?? "", theme.fg("accent", selected)]
      : [theme.fg("accent", selected), theme.fg("dim", actions)];
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
  if (state.pane === "profiles") return `/subagents profiles › ${scopeName(state.scope)}`;
  const profile = selectedProfile(state);
  if (state.pane === "candidates") return `/subagents profiles › ${profile}`;
  return `/subagents profiles › ${profile} › ${profileRouteOptionLabel(state.candidateIndex)}`;
};

const compactBreadcrumb = (state: ProfileWorkspaceRenderState): string => {
  if (state.pane === "profiles") return `/profiles › ${scopeName(state.scope)}`;
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
        : undefined;
  const status = statusText
    ? theme.fg(state.busy || state.reloadRequired ? "warning" : "accent", statusText)
    : undefined;
  const statusWidth = status ? visibleWidth(status) + 3 : 0;
  const breadcrumbWidth = Math.max(1, inner - statusWidth - 2);
  const fullBreadcrumb = breadcrumb(state);
  const titleBreadcrumb =
    visibleWidth(fullBreadcrumb) <= breadcrumbWidth ? fullBreadcrumb : compactBreadcrumb(state);
  const titleRaw = status
    ? ` ${boundedMiddle(titleBreadcrumb, breadcrumbWidth)} · ${status} `
    : ` ${boundedMiddle(titleBreadcrumb, breadcrumbWidth)} `;
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
      ? 4 + noticeRows
      : state.pane === "candidates"
        ? 6 + noticeRows
        : 4 + noticeRows;
  const rows =
    bodyHeight <= 6 || bodyHeight < minimumSelectedRow
      ? compactWorkspacePage(state, theme, bodyHeight, inner, confirmKey, cancelKey)
      : state.pane === "profiles"
        ? profilesPage(state, theme, bodyHeight, inner)
        : state.pane === "candidates"
          ? routePage(state, theme, bodyHeight, inner)
          : candidatePage(state, theme, bodyHeight, inner);
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
