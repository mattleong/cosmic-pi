import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { MAX_PROFILE_CANDIDATES } from "../../config/schema.ts";
import type { SubagentConfigInspection, SubagentConfigScope } from "../../config/store.ts";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../run/model.ts";
import type { ProfileRouteDraft } from "../profile-route-editor.ts";
import {
  candidateEffortLabel,
  candidateFieldRows,
  draftKindLabel,
  effectiveProfileSummary,
  type ProfileWorkspacePane,
} from "./profile-workspace-model.ts";
import type { SettingsSelectKeybindingId } from "./searchable-select-page.ts";

export interface ProfileWorkspaceConfirmation {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

export interface ProfileWorkspaceRenderState {
  readonly inspection: SubagentConfigInspection;
  readonly scope: SubagentConfigScope;
  readonly projectTrusted: boolean;
  readonly parentEffort: SubagentEffort;
  readonly pane: ProfileWorkspacePane;
  readonly profileIndex: number;
  readonly candidateIndex: number;
  readonly fieldIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly busy: boolean;
  readonly cancellableBusy: boolean;
  readonly reloadRequired: boolean;
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

const scopeLine = (state: ProfileWorkspaceRenderState, theme: Theme): string => {
  const global =
    state.scope === "global" ? theme.fg("accent", theme.bold("[g Global]")) : "g Global";
  const projectLabel = state.projectTrusted ? "p Project" : "p Project unavailable";
  const project =
    state.scope === "project" ? theme.fg("accent", theme.bold(`[${projectLabel}]`)) : projectLabel;
  const effect =
    state.scope === "global" ? "overrides built-in defaults" : "overrides global settings";
  return `Scope  ${global}   ${project}  · ${effect}`;
};

const wrapped = (value: string, width: number): ReadonlyArray<string> =>
  wrapTextWithAnsi(value, Math.max(1, width));

const projectOverrideActive = (state: ProfileWorkspaceRenderState): boolean => {
  if (state.scope !== "global") return false;
  const project = state.inspection.project;
  const profile = selectedProfile(state);
  return Boolean(
    project &&
    (project.invalidProfileRoutes.includes(profile) ||
      Object.prototype.hasOwnProperty.call(project.file.profiles ?? {}, profile)),
  );
};

const commonNotices = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  cancelKey = "Esc",
): ReadonlyArray<string> => {
  const lines: string[] = [];
  if (projectOverrideActive(state)) {
    lines.push(
      ...wrapped(
        theme.fg(
          "warning",
          `! Project override active for ${selectedProfile(state)}; global edits are saved but do not change its effective route until the project override is reset.`,
        ),
        width,
      ),
      "",
    );
  }
  if (state.pendingConfirmation) {
    lines.push(
      ...wrapped(
        theme.fg("warning", theme.bold(`Confirm · ${state.pendingConfirmation.title}`)),
        width,
      ),
      ...wrapped(theme.fg("warning", state.pendingConfirmation.detail), width),
      ...wrapped(
        theme.fg(
          "warning",
          `Press ${state.pendingConfirmation.key} again to confirm · ${cancelKey} cancels`,
        ),
        width,
      ),
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
    const glyph =
      state.message.kind === "error"
        ? "×"
        : state.message.kind === "warning"
          ? "!"
          : state.message.kind === "success"
            ? "✓"
            : "ℹ";
    lines.push(...wrapped(theme.fg(color, `${glyph} ${state.message.text}`), width), "");
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
): string => {
  const prefix = `${String(index + 1).padStart(2, "0")} · ${candidate.host}/${candidate.runtime} · `;
  const lifecycle = candidate.closeOnReport ? "close" : "retain";
  const effort = candidateEffortLabel(profile, candidate, parentEffort);
  const suffix = ` · ${effort} · ${candidate.context} · ${candidate.writeIntent} · ${lifecycle}`;
  const modelWidth = Math.max(4, maximum - visibleWidth(prefix) - visibleWidth(suffix));
  return truncateToWidth(
    `${prefix}${boundedMiddle(candidate.model, modelWidth)}${suffix}`,
    maximum,
  );
};

const sameCandidates = (
  left: ProfileRouteDraft["candidates"],
  right: ProfileRouteDraft["candidates"],
): boolean =>
  left.length === right.length &&
  left.every((candidate, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      candidate.host === other.host &&
      candidate.runtime === other.runtime &&
      candidate.model === other.model &&
      candidate.effort === other.effort &&
      candidate.context === other.context &&
      candidate.writeIntent === other.writeIntent &&
      candidate.closeOnReport === other.closeOnReport
    );
  });

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
      (state.scope === "project" && state.draft.kind === "inherit")
    ),
  };
};

const profilesPage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
  confirmKey: string,
  cancelKey: string,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const actions = routeActions(state);
  const notices = commonNotices(state, theme, width, cancelKey);
  const visibleCount = Math.max(1, availableHeight - 9 - notices.length);
  const start = windowStart(PROFILE_IDS.length, state.profileIndex, visibleCount);
  const visibleProfiles = PROFILE_IDS.slice(start, start + visibleCount);
  return [
    theme.fg(
      "accent",
      theme.bold(`Profiles${windowLabel(start, visibleProfiles.length, PROFILE_IDS.length)}`),
    ),
    "Choose a profile to inspect its effective route or edit its declaration. ★ marks the default.",
    scopeLine(state, theme),
    "",
    ...notices,
    ...visibleProfiles.map((entry, offset) => {
      const index = start + offset;
      const marker = index === state.profileIndex ? ">" : " ";
      const defaultMarker = entry === state.inspection.config.defaultProfile ? "★" : " ";
      return `${marker}${defaultMarker} ${entry.padEnd(11)} ${effectiveProfileSummary(state.inspection, entry)}`;
    }),
    "",
    theme.fg("muted", "Actions"),
    `  ${confirmKey.padEnd(6)} Open ${profile} route`,
    "  /      Search profiles",
    ...(actions.reset
      ? [
          `  i      Reset ${profile} ${state.scope === "global" ? "to built-in" : "to inherit global"}`,
        ]
      : []),
  ];
};

const routePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
  confirmKey: string,
  cancelKey: string,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const effective = state.inspection.config.profiles[profile];
  const candidates = state.draft.candidates;
  const notices = commonNotices(state, theme, width, cancelKey);
  const hasPreview =
    !projectOverrideActive(state) && !sameCandidates(effective.candidates, candidates);
  const reserved = 16 + (hasPreview ? 1 : 0) + notices.length;
  const visibleCount = Math.max(1, availableHeight - reserved);
  const start = windowStart(candidates.length, state.candidateIndex, visibleCount);
  const visible = candidates.slice(start, start + visibleCount);
  const rows =
    visible.length === 0
      ? [
          state.draft.kind === "invalid"
            ? "  Invalid declaration · route fails closed"
            : "  No candidates · route is disabled",
        ]
      : visible.map((candidate, offset) => {
          const index = start + offset;
          return `${index === state.candidateIndex ? ">" : " "} ${candidateSummary(profile, candidate, index, Math.max(1, width - 2), state.parentEffort)}`;
        });
  const actions = routeActions(state);
  return [
    theme.fg("accent", theme.bold(`${profile} route`)),
    PROFILE_DEFINITIONS[profile].description,
    scopeLine(state, theme),
    `Effective  ${effectiveProfileSummary(state.inspection, profile)}`,
    `Editing    ${state.scope} · ${draftKindLabel(state.draft, state.scope)}`,
    ...(hasPreview
      ? [
          `Preview    ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} after this scope`,
        ]
      : []),
    "",
    ...notices,
    theme.fg("muted", `Ordered candidates${windowLabel(start, visible.length, candidates.length)}`),
    ...rows,
    "",
    theme.fg("muted", "Actions"),
    ...(candidates.length > 0 ? [`  ${confirmKey.padEnd(6)} Edit selected candidate`] : []),
    ...(actions.add ? ["  a      Add candidate"] : []),
    ...(actions.clone ? ["  c      Clone selected candidate"] : []),
    ...(actions.moveDown ? ["  J      Move selected down"] : []),
    ...(actions.moveUp ? ["  K      Move selected up"] : []),
    ...(actions.remove ? ["  x      Remove selected candidate"] : []),
    ...(actions.disable ? ["  d      Disable route"] : []),
    ...(actions.reset
      ? [
          `  i      Reset ${profile} ${state.scope === "global" ? "to built-in" : "to inherit global"}`,
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
  const notices = commonNotices(state, theme, width, cancelKey);
  const fields = candidate ? candidateFieldRows(candidate, profile, state.parentEffort) : [];
  const visibleCount = Math.max(1, availableHeight - 9 - notices.length);
  const start = windowStart(fields.length, state.fieldIndex, visibleCount);
  const rows = candidate
    ? fields.slice(start, start + visibleCount).map((row, offset) => {
        const index = start + offset;
        const marker = index === state.fieldIndex ? ">" : " ";
        const action = row.fixed ? "fixed by policy" : `${confirmKey} to choose`;
        const compactAction = row.fixed ? "fixed" : "edit";
        const showAction = width >= 46;
        const actionLabel = showAction ? action : compactAction;
        const valueWidth = Math.max(1, width - 17 - actionLabel.length - 3);
        const value = boundedMiddle(row.value, valueWidth);
        return `${marker} ${row.label.padEnd(14)} ${value.padEnd(valueWidth)} · ${actionLabel}`;
      })
    : ["No candidate exists. Return to the route and add one."];
  return [
    theme.fg("accent", theme.bold(`${profile} › candidate ${state.candidateIndex + 1}`)),
    PROFILE_DEFINITIONS[profile].description,
    scopeLine(state, theme),
    "",
    ...notices,
    theme.fg(
      "muted",
      `Candidate fields${windowLabel(start, Math.min(visibleCount, fields.length), fields.length)}`,
    ),
    ...rows,
    "",
    theme.fg("muted", "Actions"),
    `  ${confirmKey.padEnd(6)} Choose value for selected field`,
    `  ${cancelKey.padEnd(6)} Back to ordered route`,
  ];
};

const helpText = (
  state: ProfileWorkspaceRenderState,
  width: number,
  keybindingLabel?: ((id: SettingsSelectKeybindingId, fallback: string) => string) | undefined,
): string => {
  const key = (id: SettingsSelectKeybindingId, fallback: string): string =>
    keybindingLabel?.(id, fallback) || fallback;
  const navigation = keybindingLabel
    ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
    : "↑↓";
  const enter = key("tui.select.confirm", "Enter");
  const escape = key("tui.select.cancel", "Esc");
  const pages = `${key("tui.select.pageUp", "PgUp")}/${key("tui.select.pageDown", "PgDn")}`;
  if (state.pendingConfirmation)
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [`${state.pendingConfirmation.key} Confirm`, `${escape} Cancel`],
    ]);
  if (state.busy)
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        state.cancellableBusy ? "Loading model catalog…" : "Saving or reloading…",
        state.cancellableBusy ? `${escape} Cancel` : `${escape} Wait`,
      ],
    ]);
  if (state.pane === "profiles") {
    const canReset = routeActions(state).reset;
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · ${pages} Page · Home/End`,
        `${enter} Route · / Search · g Global · ${state.projectTrusted ? "p Project" : "p Project unavailable"}`,
        `${canReset ? "i Reset · " : ""}Tab Next`,
        state.reloadRequired ? `r Reload · ${escape} Close` : `${escape} Close`,
      ],
      [
        `${navigation} · ${pages} · ${enter} · / Search`,
        `${state.projectTrusted ? "g/p Scope" : "g Global"}${canReset ? " · i Reset" : ""} · Tab`,
        state.reloadRequired ? `r Reload · ${escape}` : `${escape} Close`,
      ],
    ]);
  }
  if (state.pane === "candidates") {
    const actions = routeActions(state);
    const actionLabels = [
      actions.add ? "a Add" : undefined,
      actions.clone ? "c Clone" : undefined,
      actions.moveDown ? "J Down" : undefined,
      actions.moveUp ? "K Up" : undefined,
      actions.remove ? "x Remove" : undefined,
      actions.disable ? "d Disable" : undefined,
      actions.reset ? "i Reset" : undefined,
    ].filter((label): label is string => label !== undefined);
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · ${pages} Page · Home/End · ${enter} Candidate`,
        actionLabels.join(" · ") || "No route changes available",
        `${escape} Profiles · Tab/⇧Tab Pages`,
        state.reloadRequired ? "r Reload" : "",
      ],
      [
        `${navigation} · ${pages} · ${enter}`,
        actionLabels.join(" · ") || "No changes",
        `${escape} · Tab/⇧Tab`,
      ],
    ]);
  }
  return renderResponsiveManagerFooter(Math.max(0, width), [
    [
      `${navigation} Field · ${pages} Page · Home/End · ${enter} Choose`,
      `${state.projectTrusted ? "g/p Scope" : "g Global"} · ${escape} Route · ⇧Tab Back`,
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
  const field = candidate
    ? candidateFieldRows(candidate, profile, state.parentEffort)[state.fieldIndex]
    : undefined;
  const heading =
    state.pane === "profiles"
      ? `Profiles · ${state.profileIndex + 1}/${PROFILE_IDS.length}`
      : state.pane === "candidates"
        ? `${profile} route · ${state.draft.candidates.length === 0 ? 0 : state.candidateIndex + 1}/${state.draft.candidates.length}`
        : `${profile} · candidate ${state.candidateIndex + 1}`;
  const selected =
    state.pane === "profiles"
      ? `${profile === state.inspection.config.defaultProfile ? "★ " : ""}${profile} · ${effectiveProfileSummary(state.inspection, profile)}`
      : state.pane === "candidates"
        ? candidate
          ? candidateSummary(
              profile,
              candidate,
              state.candidateIndex,
              Math.max(1, width),
              state.parentEffort,
            )
          : state.draft.kind === "invalid"
            ? "Invalid declaration · route fails closed"
            : "No candidates · route disabled"
        : field
          ? `${field.label}: ${boundedMiddle(field.value, Math.max(1, width - field.label.length - 12))} · ${field.fixed ? "fixed" : "edit"}`
          : "No candidate · return to route";
  const actions =
    state.pane === "profiles"
      ? `${confirmKey} route · / search · g/p scope${routeActions(state).reset ? " · i reset" : ""}`
      : state.pane === "candidates"
        ? state.draft.candidates.length > 0
          ? `${confirmKey} edit · a add · x remove · ${cancelKey} profiles`
          : `a add · d disable · ${cancelKey} profiles`
        : field?.fixed
          ? `Fixed by policy · ${cancelKey} route`
          : `${confirmKey} choose · ${cancelKey} route`;
  const status: string[] = [];
  if (state.pendingConfirmation) {
    status.push(
      theme.fg(
        "warning",
        `Confirm ${state.pendingConfirmation.key}: ${state.pendingConfirmation.title}`,
      ),
      theme.fg("warning", state.pendingConfirmation.detail),
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
    const shadow = projectOverrideActive(state)
      ? " · Project override active; global edit is shadowed"
      : "";
    status.push(theme.fg(color, `${state.message.text}${shadow}`));
  } else if (projectOverrideActive(state)) {
    status.push(theme.fg("warning", "Project override active · global edit is shadowed"));
  }
  if (height <= 1) return [theme.fg("accent", selected)];
  if (height === 2) return [theme.fg("accent", selected), theme.fg("dim", actions)];
  const availableStatus = Math.max(0, height - 3);
  const middle =
    status.length > 0
      ? status.slice(0, availableStatus)
      : availableStatus > 0
        ? [scopeLine(state, theme)]
        : [];
  return [
    theme.fg("accent", theme.bold(heading)),
    ...middle,
    theme.fg("accent", selected),
    theme.fg("dim", actions),
  ].slice(0, height);
};

const breadcrumb = (state: ProfileWorkspaceRenderState): string => {
  if (state.pane === "profiles") return "/subagents profiles";
  const profile = selectedProfile(state);
  if (state.pane === "candidates") return `/subagents profiles › ${profile}`;
  return `/subagents profiles › ${profile} › candidate ${state.candidateIndex + 1}`;
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
  const status = state.busy
    ? theme.fg("warning", state.cancellableBusy ? "◌ loading catalog" : "◌ saving/reloading")
    : state.reloadRequired
      ? theme.fg("warning", "reload required")
      : theme.fg("muted", "ready");
  const titleRaw = ` ${breadcrumb(state)} · ${status} `;
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
  const noticeRows = commonNotices(state, theme, inner, cancelKey).length;
  const minimumSelectedRow =
    state.pane === "profiles"
      ? 5 + noticeRows
      : state.pane === "candidates"
        ? 8 + noticeRows
        : 6 + noticeRows;
  const rows =
    bodyHeight <= 6 || bodyHeight < minimumSelectedRow
      ? compactWorkspacePage(state, theme, bodyHeight, inner, confirmKey, cancelKey)
      : state.pane === "profiles"
        ? profilesPage(state, theme, bodyHeight, inner, confirmKey, cancelKey)
        : state.pane === "candidates"
          ? routePage(state, theme, bodyHeight, inner, confirmKey, cancelKey)
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
