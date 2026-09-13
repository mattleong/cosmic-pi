import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { listWindowStart } from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedScreen,
  framedWideRows,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { PROFILE_IDS, type ProfileId, type ProfileCandidate } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type {
  ProfileRouteDraft,
  ProfileSettingsInspection,
  ProfileSettingsScope,
  ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import {
  candidateEffortLabel,
  runWithLabel,
  candidateFastModeApplied,
  profileRouteOptionLabel,
  targetProfileRouteDraft,
  type ProfileWorkspacePane,
} from "./profile-workspace-model.ts";
import { profileWorkspaceRows } from "./profile-workspace-rows.ts";
import type { SettingsSelectKeybindingId } from "pi-cosmic-ui/manager/searchable-select";
import { profileWorkspaceKeys } from "./profile-workspace-keys.ts";

export interface ProfileWorkspaceConfirmation {
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
  readonly advancedExpanded?: boolean | undefined;
  readonly expandedCandidates?: ReadonlySet<number> | undefined;
  readonly editedProfiles?: ReadonlySet<ProfileId> | undefined;
  readonly helpOpen?: boolean | undefined;
  readonly helpScroll?: number | undefined;
  readonly backLabel?: string | undefined;
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
    : `Saving to ${target.set.scope === "project" ? "Project" : "Global"}/${target.set.name} · session not affected`;

/** Reserve metadata first: long configured model selectors must never hide reasoning. */
export const workspaceCandidateSummary = (
  candidate: ProfileCandidate,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  width: number,
  parentModel?: string,
): string => {
  const metadata = `${candidateEffortLabel(profile, candidate, parentEffort)}${candidateFastModeApplied(candidate, parentModel) ? " ⚡" : ""}`;
  const modelWidth = Math.max(0, width - visibleWidth(metadata) - 3);
  return modelWidth > 0
    ? `${truncateToWidth(candidate.model, modelWidth)} · ${metadata}`
    : truncateToWidth(metadata, width);
};
const expanded = (state: ProfileWorkspaceRenderState): ReadonlySet<number> =>
  state.expandedCandidates ?? new Set(state.advancedExpanded ? [state.candidateIndex] : []);

const profileLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const count = Math.max(1, height - 1);
  const start = listWindowStart(PROFILE_IDS.length, state.profileIndex, count);
  const rows = PROFILE_IDS.map((profile, index) => {
    const selected = index === state.profileIndex;
    const draft = selected
      ? state.draft
      : targetProfileRouteDraft(state.inspection, state.target, profile);
    const first = draft.kind === "invalid" ? undefined : draft.candidates[0];
    return {
      profile,
      selected,
      model: first?.model ?? (draft.kind === "invalid" ? "invalid" : "disabled"),
      effort: first
        ? `${candidateEffortLabel(profile, first, state.parentEffort)}${candidateFastModeApplied(first, state.parentModel) ? " ⚡" : ""}`
        : "",
      runtime: first ? runWithLabel(first) : "",
      fallbacks:
        draft.candidates.length > 1
          ? `+${draft.candidates.length - 1} fallback${draft.candidates.length === 2 ? "" : "s"}`
          : "",
    };
  });
  // Measure every profile so scrolling never shifts the columns. Reserve the edit marker too.
  const profileWidth = Math.max(...PROFILE_IDS.map(visibleWidth)) + 2;
  const remaining = Math.max(0, width - profileWidth - 5);
  const effortWidth = Math.min(remaining, Math.max(...rows.map((row) => visibleWidth(row.effort))));
  const modelWidth = Math.min(
    Math.max(...rows.map((row) => visibleWidth(row.model))),
    Math.max(0, remaining - effortWidth - 3),
  );
  const spare = Math.max(0, remaining - modelWidth - effortWidth - 3);
  const runtimeWidth = Math.max(...rows.map((row) => visibleWidth(row.runtime)));
  const showRuntime = runtimeWidth > 0 && spare >= runtimeWidth + 3;
  const fallbackWidth = Math.max(...rows.map((row) => visibleWidth(row.fallbacks)));
  const showFallbacks =
    fallbackWidth > 0 && spare - (showRuntime ? runtimeWidth + 3 : 0) >= fallbackWidth + 3;
  const cell = (text: string, columns: number): string => {
    const clipped = truncateToWidth(text, columns);
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  return [
    theme.fg(state.pane === "profiles" ? "accent" : "muted", theme.bold("Profiles")),
    ...rows.slice(start, start + count).map((row) => {
      const marker = state.editedProfiles?.has(row.profile) ? theme.fg("accent", " ●") : "";
      const prefix = `${row.selected ? ">" : " "} ${cell(row.profile + marker, profileWidth)} · `;
      const columns = row.effort
        ? [
            ...(modelWidth > 0 ? [cell(row.model, modelWidth)] : []),
            cell(row.effort, effortWidth),
            ...(showRuntime ? [cell(row.runtime, runtimeWidth)] : []),
            ...(showFallbacks ? [row.fallbacks] : []),
          ]
        : [row.model];
      const line = truncateToWidth(prefix + columns.join(" · "), width);
      return row.selected && state.pane === "profiles" ? theme.fg("accent", line) : line;
    }),
  ];
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
    expanded(state),
    state.target.kind === "session",
  );
  const lines: string[] = [];
  let selectedLine = 0;
  let previousCandidate = -1;
  rows.forEach((row, index) => {
    if (row.candidateIndex !== previousCandidate) {
      const candidate = state.draft.candidates[row.candidateIndex];
      const label = profileRouteOptionLabel(row.candidateIndex);
      lines.push(
        theme.fg(
          "accent",
          theme.bold(
            candidate
              ? `${label}  ${workspaceCandidateSummary(candidate, profile, state.parentEffort, Math.max(0, width - visibleWidth(label) - 2), state.parentModel)}`
              : state.draft.kind === "invalid"
                ? "Invalid profile, add a model to repair"
                : "Disabled profile",
          ),
        ),
      );
      previousCandidate = row.candidateIndex;
    }
    if (index === state.fieldIndex) selectedLine = lines.length;
    const selected = index === state.fieldIndex && state.pane !== "profiles";
    const text = truncateToWidth(
      `${selected ? ">" : " "} ${row.label}  ${row.value}${row.fixed ? " · fixed" : ""}`,
      width,
    );
    lines.push(selected ? theme.fg("accent", text) : row.fixed ? theme.fg("muted", text) : text);
  });
  const limit = Math.max(0, height - 1);
  const start = listWindowStart(lines.length, selectedLine, limit);
  return [
    theme.fg(
      state.pane === "profiles" ? "muted" : "accent",
      theme.bold(`${profile} · ${profileRouteOptionLabel(state.candidateIndex)}`),
    ),
    ...lines.slice(start, start + limit),
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
    `${keys.up}/${keys.down} Select profile or field`,
    "Left / k focuses profiles. Right / j focuses fields.",
    "Tab / Shift+Tab switches Current Session and Saved profiles.",
    "[ / ] Previous / next candidate",
    "",
    "Editing",
    `${keys.confirm} Open the selected field or Actions`,
    "m Model · e Reasoning · r Run with",
    "a Actions · + Add fallback",
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
  const frame = listDetailFrame(theme);
  const keys = profileWorkspaceKeys(
    options.keybindingLabel,
    Boolean(state.pendingConfirmation) || state.busy,
  );
  const back =
    state.pane === "profiles"
      ? (state.backLabel ?? (state.target.kind === "session" ? "Close" : "Saved profiles"))
      : "Profiles";
  const context =
    state.target.kind === "session"
      ? "Current Session"
      : `${state.target.set.scope === "project" ? "Project" : "Global"}/${state.target.set.name}`;
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
              "m Model · a Actions · ? Help",
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
    top: truncateToWidth(` ${targetHeading(state.target)} `, inner, ""),
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
        );
      }
      if (state.pendingConfirmation) {
        const confirmation = state.pendingConfirmation;
        return framedFill(
          frame,
          [
            context,
            confirmation.title,
            confirmation.detail,
            ...(confirmation.preview ?? []),
          ].flatMap((line) => wrapTextWithAnsi(theme.fg("warning", line), inner)),
          bodyHeight,
          inner,
        );
      }
      if (bodyHeight <= 4) {
        const profile = selectedProfile(state);
        const candidate = state.draft.candidates[state.candidateIndex];
        const scope =
          state.target.kind === "profile-set"
            ? `${state.target.set.scope === "project" ? "Project" : "Global"} · `
            : "";
        const prefix = `${scope}${profile} · `;
        const summary = candidate
          ? workspaceCandidateSummary(
              candidate,
              profile,
              state.parentEffort,
              Math.max(0, inner - visibleWidth(prefix)),
              state.parentModel,
            )
          : state.draft.kind;
        const selected = profileWorkspaceRows(
          state.draft,
          profile,
          state.parentEffort,
          state.parentModel,
          expanded(state),
          state.target.kind === "session",
        )[state.fieldIndex];
        return framedFill(
          frame,
          [prefix + summary, ...(selected ? [`${selected.label}  ${selected.value}`] : [])],
          bodyHeight,
          inner,
        );
      }
      const notices: string[] = [];
      if (state.target.kind === "profile-set")
        notices.push(
          theme.fg("muted", state.target.set.scope === "project" ? "Project" : "Global"),
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
      if (width >= 100) {
        const listWidth = Math.min(64, Math.floor(inner * 0.4));
        const detailWidth = inner - listWidth - 1;
        body = framedWideRows(frame, {
          left: profileLines(state, theme, listWidth, available),
          right: editorLines(state, theme, detailWidth, available),
          height: available,
          listWidth,
          detailWidth,
        });
      } else {
        body = framedFill(
          frame,
          state.pane === "profiles"
            ? profileLines(state, theme, inner, available)
            : editorLines(state, theme, inner, available),
          available,
          inner,
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
