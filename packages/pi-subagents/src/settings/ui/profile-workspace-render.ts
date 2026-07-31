import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import type { SubagentConfigInspection, SubagentConfigScope } from "../../config/store.ts";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS } from "../../profiles/model.ts";
import { candidateMenuSummary, type ProfileRouteDraft } from "../profile-route-editor.ts";
import {
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

const commonNotices = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  const lines: string[] = [];
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
          `Press ${state.pendingConfirmation.key} again to confirm · Esc cancels`,
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
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  const right = Math.max(0, maximum - left - 1);
  return `${value.slice(0, left)}…${right > 0 ? value.slice(-right) : ""}`;
};

const windowStart = (length: number, selected: number, visibleCount: number): number =>
  Math.max(
    0,
    Math.min(Math.max(0, length - visibleCount), selected - Math.floor(visibleCount / 2)),
  );

const profilesPage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const notices = commonNotices(state, theme, width);
  const visibleCount = Math.max(1, availableHeight - 9 - notices.length);
  const start = windowStart(PROFILE_IDS.length, state.profileIndex, visibleCount);
  const visibleProfiles = PROFILE_IDS.slice(start, start + visibleCount);
  return [
    theme.fg(
      "accent",
      theme.bold(`Profiles${windowLabel(start, visibleProfiles.length, PROFILE_IDS.length)}`),
    ),
    "Choose a profile to inspect its effective route or edit its declaration.",
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
    `  Enter  Open ${profile} route`,
    "  /      Search profiles",
    `  i      Reset ${profile} ${state.scope === "global" ? "to built-in" : "to inherit global"}`,
  ];
};

const routePage = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  availableHeight: number,
  width: number,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const effective = state.inspection.config.profiles[profile];
  const candidates = state.draft.candidates;
  const notices = commonNotices(state, theme, width);
  const hasPreview = effective.candidates.length !== candidates.length;
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
          return `${index === state.candidateIndex ? ">" : " "} ${candidateMenuSummary(candidate, index)}`;
        });
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
    ...(candidates.length > 0
      ? [
          "  Enter  Edit selected candidate",
          "  a      Add candidate",
          "  c      Clone selected candidate",
          "  J / K  Move selected down / up",
          "  x      Remove selected candidate",
        ]
      : ["  a      Add candidate"]),
    "  d      Disable route",
    `  i      Reset ${profile} ${state.scope === "global" ? "to built-in" : "to inherit global"}`,
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
  const notices = commonNotices(state, theme, width);
  const fields = candidate ? candidateFieldRows(candidate) : [];
  const visibleCount = Math.max(1, availableHeight - 9 - notices.length);
  const start = windowStart(fields.length, state.fieldIndex, visibleCount);
  const rows = candidate
    ? fields.slice(start, start + visibleCount).map((row, offset) => {
        const index = start + offset;
        const marker = index === state.fieldIndex ? ">" : " ";
        const action = row.fixed ? "fixed by policy" : "Enter to choose";
        const showAction = width >= 46;
        const valueWidth = Math.max(6, width - 17 - (showAction ? action.length + 2 : 0));
        const value = boundedMiddle(row.value, valueWidth);
        return `${marker} ${row.label.padEnd(14)} ${value.padEnd(valueWidth)}${showAction ? `  ${action}` : ""}`;
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
    "  Enter  Choose value for selected field",
    "  Esc    Back to ordered route",
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
  if (state.pane === "profiles")
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · ${enter} Route · / Search`,
        "g Global · p Project · i Reset · Tab Next",
        state.reloadRequired ? `r Reload · ${escape} Close` : `${escape} Close`,
      ],
      [
        `${navigation} · ${enter} · / Search`,
        "g/p Scope · i Reset · Tab",
        state.reloadRequired ? `r Reload · ${escape}` : `${escape} Close`,
      ],
    ]);
  if (state.pane === "candidates")
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        `${navigation} Select · ${enter} Candidate`,
        "a Add · c Clone · J/K Move · x Remove",
        `d Disable · i Reset · ${escape} Profiles · Tab/⇧Tab Pages`,
        state.reloadRequired ? "r Reload" : "",
      ],
      [
        `${navigation} · ${enter} · a Add`,
        "c Clone · J/K · x Remove",
        `d Disable · i Reset · ${escape}`,
      ],
    ]);
  return renderResponsiveManagerFooter(Math.max(0, width), [
    [
      `${navigation} Field · ${enter} Choose`,
      `g/p Scope · ${escape} Route · ⇧Tab Back`,
      state.reloadRequired ? "r Reload" : "",
    ],
  ]);
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
    ? theme.fg("warning", "saving/loading")
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
  const footer = truncateToWidth(helpText(state, inner, options.keybindingLabel), inner, "");
  const bottom = `${theme.fg("borderAccent", "╰")}${theme.fg(
    "borderAccent",
    "─".repeat(Math.max(0, inner - visibleWidth(footer))),
  )}${footer}${theme.fg("borderAccent", "╯")}`;
  const bodyHeight = Math.max(0, height - 2);
  const rows =
    state.pane === "profiles"
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
