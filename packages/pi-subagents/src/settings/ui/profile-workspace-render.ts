import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { listWindowStart } from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailHeading,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { managerLayoutTier, renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { managerTable } from "pi-cosmic-ui/manager/table";
import { PROFILE_IDS, type ProfileId, type ProfileCandidate } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  loadProfileRouteDraft,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import {
  candidateEffortLabel,
  runWithLabel,
  candidateFastModeApplied,
  profileRouteOptionLabel,
  type ProfileWorkspacePane,
} from "./profile-workspace-model.ts";
import { profileWorkspaceRows, type ProfileWorkspaceRow } from "./profile-workspace-rows.ts";
import { focusedProfileField, profileTone } from "./profile-style.ts";
import type { SettingsSelectKeybindingId } from "pi-cosmic-ui/manager/searchable-select";
import { profileWorkspaceKeys } from "./profile-workspace-keys.ts";
import { qualifiedProfileSetLabel } from "./profile-set-picker-model.ts";

export interface ProfileWorkspaceConfirmation {
  readonly title: string;
  readonly detail: string;
}
export interface ProfileWorkspaceRenderState {
  readonly inspection: ProfileSettingsInspection;
  readonly target: ProfileWorkspaceTarget;
  readonly parentEffort: SubagentEffort;
  readonly parentModel?: string | undefined;
  readonly pane: ProfileWorkspacePane;
  readonly profileIndex: number;
  readonly saveFocused?: boolean | undefined;
  readonly candidateIndex: number;
  readonly fieldIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly expandedCandidates: ReadonlySet<number>;
  readonly editedProfiles?: ReadonlySet<ProfileId> | undefined;
  readonly helpOpen?: boolean | undefined;
  readonly helpScroll?: number | undefined;
  readonly busy: boolean;
  readonly cancellableBusy: boolean;
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
const selectedProfile = (state: ProfileWorkspaceRenderState): ProfileId =>
  PROFILE_IDS[state.profileIndex] ?? PROFILE_IDS[0];
const targetHeading = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Editing Current Session"
    : `Editing ${target.set.name} · session not affected`;
const destination = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Changes affect later launches. Active runs are unchanged."
    : `Saving to ${qualifiedProfileSetLabel(target.set)} · session not affected`;

/** Reserve metadata first: long configured model selectors must never hide reasoning. */
export const workspaceCandidateSummary = (
  candidate: ProfileCandidate,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  width: number,
  parentModel: string | undefined,
  theme: Theme,
): string => {
  const effort = candidateEffortLabel(profile, candidate, parentEffort);
  const fast = candidateFastModeApplied(candidate, parentModel) ? " ⚡" : "";
  const metadata = `${theme.fg("muted", effort)}${theme.fg("warning", fast)}`;
  const modelWidth = Math.max(0, width - visibleWidth(metadata) - 3);
  return modelWidth > 0
    ? `${theme.fg(profileTone.model, truncateToWidth(candidate.model, modelWidth))} · ${metadata}`
    : truncateToWidth(metadata, width);
};

const profileTableLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  const rows = PROFILE_IDS.map((profile, index) => {
    const selected = index === state.profileIndex;
    const draft = selected
      ? state.draft
      : loadProfileRouteDraft(state.inspection, state.target, profile);
    const first = draft.kind === "invalid" ? undefined : draft.candidates[0];
    return {
      profile,
      selected: selected && !state.saveFocused,
      model: theme.fg(
        first ? profileTone.model : draft.kind === "invalid" ? "error" : "muted",
        first?.model ?? (draft.kind === "invalid" ? "invalid" : "disabled"),
      ),
      effort: first
        ? `${theme.fg("muted", candidateEffortLabel(profile, first, state.parentEffort))}${candidateFastModeApplied(first, state.parentModel) ? theme.fg("warning", " ⚡") : ""}`
        : "",
      runtime: first ? runWithLabel(first) : "",
      fallbacks:
        draft.candidates.length > 1
          ? `+${draft.candidates.length - 1} fallback${draft.candidates.length === 2 ? "" : "s"}`
          : "",
    };
  });
  const table = managerTable(
    rows.map((row) => [row.profile + " ●", row.model, row.effort, row.runtime, row.fallbacks]),
    [
      { minWidth: 12, priority: 5 },
      { minWidth: 8, priority: 3 },
      { minWidth: 7, priority: 4 },
      { minWidth: 8, priority: 2 },
      { minWidth: 11, priority: 1 },
    ],
    width - 2,
  );
  return rows.map((row) => {
    const identity =
      row.selected && state.pane === "profiles"
        ? focusedProfileField(theme, row.profile)
        : theme.fg(profileTone.profile, row.profile);
    const marker = state.editedProfiles?.has(row.profile) ? theme.fg("warning", " ●") : "";
    return `${row.selected ? ">" : " "} ${table.row([
      identity + marker,
      row.model,
      row.effort,
      theme.fg("muted", row.runtime),
      theme.fg("muted", row.fallbacks),
    ])}`;
  });
};

const profileLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const save = truncateToWidth(
    `${state.saveFocused ? ">" : " "} Save these profiles as a set…`,
    width,
  );
  const lines = [
    ...profileTableLines(state, theme, width),
    ...(state.target.kind === "session"
      ? [
          "",
          theme.fg(profileTone.session, theme.bold("Current Session")),
          state.saveFocused && state.pane === "profiles" ? focusedProfileField(theme, save) : save,
        ]
      : []),
  ];
  const count = Math.max(1, height - 1);
  const selected = state.saveFocused ? lines.length - 1 : state.profileIndex;
  const start = listWindowStart(lines.length, selected, count);
  return [
    listDetailHeading(theme, "Profiles", state.pane === "profiles"),
    ...lines.slice(start, start + count),
  ];
};

const fieldValue = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  row: ProfileWorkspaceRow,
): string => {
  if (row.fixed) return theme.fg("muted", row.value);
  if (state.draft.kind === "invalid") return theme.fg("error", row.value);
  if (row.scope !== "candidate") return row.value;
  const candidate = state.draft.candidates[row.candidateIndex];
  if (row.field === "model") return theme.fg(profileTone.model, row.value);
  if (row.field === "openaiFastMode" && candidate?.openaiFastMode)
    return theme.fg("warning", row.value);
  return theme.fg(
    row.field === "effort" && candidate?.effort === "default" ? "muted" : "text",
    row.value,
  );
};

const editorLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const rows = profileWorkspaceRows(
    state.draft,
    profile,
    state.parentEffort,
    state.parentModel,
    state.expandedCandidates,
    state.editedProfiles?.has(profile) ?? false,
  );
  const labelWidth = Math.max(
    0,
    ...rows.filter((row) => row.value.length > 0).map((row) => visibleWidth(row.label)),
  );
  const lines: string[] = [];
  let selectedLine = 0;
  let previousSection: string | undefined;
  rows.forEach((row, index) => {
    const section = row.scope === "candidate" ? `candidate:${row.candidateIndex}` : row.scope;
    if (section !== previousSection) {
      if (previousSection !== undefined) lines.push("");
      if (row.scope === "candidate") {
        const candidate = state.draft.candidates[row.candidateIndex]!;
        const label = profileRouteOptionLabel(row.candidateIndex);
        lines.push(
          theme.fg(
            "muted",
            theme.bold(
              `${label}  ${workspaceCandidateSummary(candidate, profile, state.parentEffort, Math.max(0, width - visibleWidth(label) - 2), state.parentModel, theme)}`,
            ),
          ),
        );
      } else {
        lines.push(
          theme.fg("muted", "Profile: ") + theme.fg(profileTone.profile, theme.bold(profile)),
        );
      }
      previousSection = section;
    }
    if (index === state.fieldIndex) selectedLine = lines.length;
    const selected = index === state.fieldIndex && state.pane !== "profiles";
    const value = row.value
      ? `${" ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)) + 2)}${selected && !row.fixed ? row.value : fieldValue(state, theme, row)}`
      : "";
    const text = truncateToWidth(
      `${selected ? ">" : " "} ${row.label}${value}${row.scope === "candidate" && row.fixed ? " · fixed" : ""}`,
      width,
    );
    lines.push(
      selected && !row.fixed
        ? focusedProfileField(theme, text)
        : row.fixed
          ? theme.fg("muted", text)
          : text,
    );
  });
  const limit = Math.max(0, height - 1);
  const start = listWindowStart(lines.length, selectedLine, limit);
  return [
    listDetailHeading(theme, profile, state.pane !== "profiles", profileTone.profile),
    ...lines.slice(start, start + limit),
  ];
};

const compactLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  if (state.pane === "profiles" && state.saveFocused)
    return [
      theme.fg(profileTone.session, "Current Session"),
      focusedProfileField(theme, "> Save these profiles as a set…"),
    ];
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  const scope =
    state.target.kind === "profile-set"
      ? `${state.target.set.scope === "project" ? "Project" : "Global"} · `
      : "";
  const prefix = `${theme.fg("muted", scope)}${theme.fg(profileTone.profile, profile)} · `;
  const summary = candidate
    ? workspaceCandidateSummary(
        candidate,
        profile,
        state.parentEffort,
        Math.max(0, width - visibleWidth(prefix)),
        state.parentModel,
        theme,
      )
    : theme.fg(state.draft.kind === "invalid" ? "error" : "muted", state.draft.kind);
  const selected = profileWorkspaceRows(
    state.draft,
    profile,
    state.parentEffort,
    state.parentModel,
    state.expandedCandidates,
  )[state.fieldIndex];
  const field = selected
    ? `${selected.label}  ${state.pane !== "profiles" && !selected.fixed ? selected.value : fieldValue(state, theme, selected)}`
    : "";
  return [
    prefix + summary,
    ...(selected
      ? [
          selected.fixed
            ? theme.fg("muted", field)
            : state.pane !== "profiles"
              ? focusedProfileField(theme, field)
              : field,
        ]
      : []),
  ];
};

export const profileWorkspaceHelpLines = (
  labels: ProfileWorkspaceRenderOptions["keybindingLabel"],
  width: number,
): ReadonlyArray<string> => {
  const keys = profileWorkspaceKeys(labels);
  return [
    "Profile editor help",
    "",
    "Navigation",
    `${keys.up}/${keys.down} or k/j selects a profile or field`,
    "Left / h focuses profiles. Right / l focuses fields.",
    "Tab / Shift+Tab switches Current Session and Saved profiles.",
    "[ / ] Previous / next candidate",
    "",
    "Editing",
    `${keys.confirm} Open the selected field or Actions`,
    "m Model · e Reasoning · r Run with",
    "a Manage selected candidate · + Add fallback",
    "/ Search profiles",
    "",
    "Changes save automatically to the named editing target.",
    "Undo changes restores this visit's opening profile.",
    `${keys.cancel} or ? closes help`,
  ].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
};
export const renderProfileWorkspace = (
  state: ProfileWorkspaceRenderState,
  options: ProfileWorkspaceRenderOptions,
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (!width || !height) return [];
  if (width < 4) return Array.from({ length: height }, () => " ".repeat(width));
  const inner = width - 2;
  const { theme } = options;
  const frame = listDetailFrame(theme, state.pane === "profiles" ? "list" : "detail");
  const keys = profileWorkspaceKeys(
    options.keybindingLabel,
    Boolean(state.pendingConfirmation) || state.busy,
  );
  const back =
    state.pane === "profiles"
      ? state.target.kind === "session"
        ? "Close"
        : "Saved profiles"
      : "Profiles";
  const context =
    state.target.kind === "session"
      ? "Current Session"
      : qualifiedProfileSetLabel(state.target.set);
  const bottom = state.pendingConfirmation
    ? `${keys.confirm} Confirm · ${keys.cancel} Cancel`
    : state.helpOpen
      ? `↑/↓ Scroll help · ${keys.cancel} Close help`
      : state.busy
        ? state.cancellableBusy
          ? `${keys.cancel} Cancel loading`
          : "Saving…"
        : renderResponsiveManagerFooter(inner, [
            [
              `${keys.confirm} Open`,
              state.target.kind === "session" ? "Tab Saved profiles" : "Tab Current Session",
              "m Model · a Manage · ? Help",
              `${keys.cancel} ${back}`,
            ],
            [
              state.target.kind === "session" ? "Tab Saved profiles" : "Tab Current Session",
              "? Help",
              `${keys.cancel} ${back}`,
            ],
          ]);
  return framedScreen(frame, {
    width,
    height,
    top: theme.fg(
      state.target.kind === "session" ? profileTone.session : profileTone.saved,
      truncateToWidth(` ${targetHeading(state.target)} `, inner, ""),
    ),
    bottom: truncateToWidth(bottom, inner, ""),
    body: (bodyHeight) => {
      if (state.helpOpen) {
        const content = profileWorkspaceHelpLines(options.keybindingLabel, inner);
        const limit = Math.max(1, bodyHeight - 1);
        const start = Math.max(0, Math.min(state.helpScroll ?? 0, content.length - limit));
        return framedFill(
          frame,
          [context, ...content.slice(start, start + limit)],
          bodyHeight,
          inner,
          "list",
        );
      }
      if (state.pendingConfirmation) {
        const confirmation = state.pendingConfirmation;
        return framedFill(
          frame,
          [context, confirmation.title, confirmation.detail].flatMap((line) =>
            wrapTextWithAnsi(theme.fg("warning", line), inner),
          ),
          bodyHeight,
          inner,
          "list",
        );
      }
      if (bodyHeight <= 4)
        return framedFill(frame, compactLines(state, theme, inner), bodyHeight, inner, "list");
      const notices: string[] = [];
      if (state.target.kind === "profile-set")
        notices.push(
          theme.fg(profileTone.saved, state.target.set.scope === "project" ? "Project" : "Global"),
        );
      if (state.message && state.message.kind !== "success")
        notices.push(
          ...wrapTextWithAnsi(
            theme.fg(
              state.message.kind === "info" ? "muted" : state.message.kind,
              state.message.text,
            ),
            inner,
          ).slice(0, 2),
        );
      const available = Math.max(0, bodyHeight - notices.length - 1);
      let body: ReadonlyArray<string>;
      if (managerLayoutTier(width) === "wide") {
        const listWidth = Math.min(64, Math.floor(inner * 0.4));
        const detailWidth = inner - listWidth - 1;
        body = framedWideRows(frame, {
          left: profileLines(state, theme, listWidth, available),
          right: editorLines(state, theme, detailWidth, available),
          height: available,
          listWidth,
          detailWidth,
        });
      } else if (managerLayoutTier(width) === "stacked" && available >= 6) {
        const listHeight = Math.max(2, Math.floor(available * 0.4));
        body = framedStackedRows(frame, {
          list: profileLines(state, theme, inner, listHeight),
          detail: editorLines(state, theme, inner, available - listHeight - 1),
          height: available,
          inner,
        });
      } else {
        body = framedFill(
          frame,
          state.pane === "profiles"
            ? profileLines(state, theme, inner, available)
            : editorLines(state, theme, inner, available),
          available,
          inner,
          state.pane === "profiles" ? "list" : "detail",
        );
      }
      return [
        ...framedFill(frame, notices, notices.length, inner),
        ...body,
        ...framedFill(
          frame,
          [
            theme.fg(
              "muted",
              `${state.message?.kind === "success" ? "✓ Saved · " : ""}${destination(state.target)}`,
            ),
          ],
          Math.min(1, bodyHeight),
          inner,
        ),
      ];
    },
  });
};
