import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const commonNotices = (state: ProfileWorkspaceRenderState, theme: Theme): ReadonlyArray<string> => {
  const lines: string[] = [];
  if (state.pendingConfirmation) {
    lines.push(
      theme.fg("warning", theme.bold(`Confirm · ${state.pendingConfirmation.title}`)),
      theme.fg("warning", state.pendingConfirmation.detail),
      theme.fg("warning", `Press ${state.pendingConfirmation.key} again to confirm · Esc cancels`),
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
      theme.fg(color, `${state.message.kind === "success" ? "✓" : "•"} ${state.message.text}`),
      "",
    );
  }
  return lines;
};

const profilesPage = (state: ProfileWorkspaceRenderState, theme: Theme): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  return [
    theme.fg("accent", theme.bold("Profiles")),
    "Choose a profile to inspect its effective route or edit its declaration.",
    scopeLine(state, theme),
    "",
    ...commonNotices(state, theme),
    ...PROFILE_IDS.map((entry, index) => {
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
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const effective = state.inspection.config.profiles[profile];
  const candidates = state.draft.candidates;
  const reserved = 17 + commonNotices(state, theme).length;
  const visibleCount = Math.max(1, availableHeight - reserved);
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, candidates.length - visibleCount),
      state.candidateIndex - Math.floor(visibleCount / 2),
    ),
  );
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
    ...(effective.candidates.length !== candidates.length
      ? [
          `Preview    ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} after this scope`,
        ]
      : []),
    "",
    ...commonNotices(state, theme),
    theme.fg("muted", "Ordered candidates"),
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

const candidatePage = (state: ProfileWorkspaceRenderState, theme: Theme): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  const rows = candidate
    ? candidateFieldRows(candidate).map((row, index) => {
        const marker = index === state.fieldIndex ? ">" : " ";
        const action = row.fixed ? "fixed by policy" : "Enter to choose";
        return `${marker} ${row.label.padEnd(14)} ${row.value.padEnd(18)} ${action}`;
      })
    : ["No candidate exists. Return to the route and add one."];
  return [
    theme.fg("accent", theme.bold(`${profile} › candidate ${state.candidateIndex + 1}`)),
    PROFILE_DEFINITIONS[profile].description,
    scopeLine(state, theme),
    "",
    ...commonNotices(state, theme),
    theme.fg("muted", "Candidate fields"),
    ...rows,
    "",
    theme.fg("muted", "Actions"),
    "  Enter  Choose value for selected field",
    "  Esc    Back to ordered route",
  ];
};

const helpText = (state: ProfileWorkspaceRenderState, width: number): string => {
  if (state.pendingConfirmation)
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [`${state.pendingConfirmation.key} Confirm`, "Esc Cancel"],
    ]);
  if (state.busy)
    return renderResponsiveManagerFooter(Math.max(0, width), [["Saving or loading…", "Esc Wait"]]);
  if (state.pane === "profiles")
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        "↑↓ Select · Enter Route · / Search",
        "g Global · p Project · i Reset",
        state.reloadRequired ? "r Reload · Esc Close" : "Esc Close",
      ],
      [
        "↑↓ · Enter · / Search",
        "g/p Scope · i Reset",
        state.reloadRequired ? "r Reload · Esc" : "Esc Close",
      ],
    ]);
  if (state.pane === "candidates")
    return renderResponsiveManagerFooter(Math.max(0, width), [
      [
        "↑↓ Select · Enter Candidate",
        "a Add · c Clone · J/K Move · x Remove",
        "d Disable · i Reset · Esc Profiles",
        state.reloadRequired ? "r Reload" : "",
      ],
      ["↑↓ · Enter · a Add", "c Clone · J/K · x Remove", "d Disable · i Reset · Esc"],
    ]);
  return renderResponsiveManagerFooter(Math.max(0, width), [
    ["↑↓ Field · Enter Choose", "Esc Route", state.reloadRequired ? "r Reload" : ""],
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
      : theme.fg("success", "saved");
  const titleRaw = ` ${breadcrumb(state)} · ${status} `;
  const title = truncateToWidth(titleRaw, inner, "");
  const top = `${theme.fg("borderAccent", "╭")}${title}${theme.fg(
    "borderAccent",
    `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`,
  )}`;
  if (height === 1) return [truncateToWidth(top, width, "")];
  const footer = truncateToWidth(helpText(state, inner), inner, "");
  const bottom = `${theme.fg("borderAccent", "╰")}${theme.fg(
    "borderAccent",
    "─".repeat(Math.max(0, inner - visibleWidth(footer))),
  )}${footer}${theme.fg("borderAccent", "╯")}`;
  const bodyHeight = Math.max(0, height - 2);
  const rows =
    state.pane === "profiles"
      ? profilesPage(state, theme)
      : state.pane === "candidates"
        ? routePage(state, theme, bodyHeight)
        : candidatePage(state, theme);
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
