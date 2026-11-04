import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { listWindowStart } from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailHeading,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, LIST_CURSOR, managerTone } from "pi-cosmic-ui/manager/style";
import {
  managerLayoutTier,
  managerNoticeColor,
  renderResponsiveManagerFooter,
  clipToWidth,
} from "pi-cosmic-ui/manager";
import { managerTable } from "pi-cosmic-ui/manager/table";
import { exitKeyHint, helpKeyHint, joinKeyHints, keyHint } from "pi-cosmic-ui/manager/key-labels";
import { PROFILE_IDS, type ProfileId, type ProfileCandidate } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  loadProfileRouteDraft,
  profileRouteOptionLabel,
  SCOPE_LABELS,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import {
  candidateEffortLabel,
  candidateEffortLevel,
  candidateFastModeApplied,
  profileWorkspaceRows,
  type ProfileWorkspacePane,
  type ProfileWorkspaceRow,
} from "./profile-workspace-model.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { profileWorkspaceKeys } from "./profile-workspace-keys.ts";
import { qualifiedProfileSetLabel } from "./profile-set-picker-model.ts";

export interface ProfileWorkspaceConfirmation {
  readonly title: string;
  readonly detail: string;
}
interface ProfileWorkspaceRenderState {
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
interface ProfileWorkspaceRenderOptions {
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly keybindingLabel?: SearchableSelectHostOptions["keybindingLabel"];
}
const selectedProfile = (state: ProfileWorkspaceRenderState): ProfileId =>
  PROFILE_IDS[state.profileIndex] ?? PROFILE_IDS[0];
const editorRows = (state: ProfileWorkspaceRenderState, profile: ProfileId) =>
  profileWorkspaceRows(
    state.draft,
    profile,
    state.parentEffort,
    state.parentModel,
    state.expandedCandidates,
    state.editedProfiles?.has(profile) ?? false,
  );
const targetHeading = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Editing Current Session"
    : `Editing ${target.set.name} · session not affected`;
const destination = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Changes affect later launches. Active runs are unchanged."
    : `Saving to ${qualifiedProfileSetLabel(target.set)} · session not affected`;

const workspaceCandidateSummary = (
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
    ? `${theme.fg(managerTone.value, clipToWidth(candidate.model, modelWidth))} · ${metadata}`
    : clipToWidth(metadata, width);
};

interface ProfileTableRow {
  readonly profile: ProfileId;
  readonly selected: boolean;
  readonly model: string;
  readonly effort: string;
  readonly fallbacks: string;
}

const profileTableRows = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
): ReadonlyArray<ProfileTableRow> =>
  Arr.map(PROFILE_IDS, (profile, index) => {
    const selected = index === state.profileIndex;
    const draft = selected
      ? state.draft
      : loadProfileRouteDraft(state.inspection, state.target, profile);
    const first = draft.kind === "invalid" ? undefined : draft.candidates[0];
    return {
      profile,
      selected: selected && !state.saveFocused,
      model: theme.fg(
        first ? managerTone.value : draft.kind === "invalid" ? "error" : "muted",
        first?.model ?? (draft.kind === "invalid" ? "invalid" : "disabled"),
      ),
      // The list names the reasoning level; the editor pane says when it is the profile default.
      effort: first
        ? `${theme.fg("muted", candidateEffortLevel(profile, first, state.parentEffort))}${candidateFastModeApplied(first, state.parentModel) ? theme.fg("warning", " ⚡") : ""}`
        : "",
      fallbacks:
        draft.candidates.length > 1
          ? `+${draft.candidates.length - 1} fallback${draft.candidates.length === 2 ? "" : "s"}`
          : "",
    };
  });

const PROFILE_COLUMN_GAP = 2;
const PROFILE_CURSOR_WIDTH = 2;

/** The width the profile table needs to show every model and fallback count unclipped. */
const profileTableNaturalWidth = (rows: ReadonlyArray<ProfileTableRow>): number => {
  const widest = (cell: (row: ProfileTableRow) => string) =>
    Math.max(0, ...Arr.map(rows, (row) => visibleWidth(cell(row))));
  const columns = [
    widest((row) => `${row.profile} ●`),
    widest((row) => row.model),
    widest((row) => row.effort),
    widest((row) => row.fallbacks),
  ];
  const shown = Arr.filter(columns, (width) => width > 0);
  return (
    PROFILE_CURSOR_WIDTH +
    Arr.reduce(shown, 0, (total, width) => total + width) +
    PROFILE_COLUMN_GAP * Math.max(0, shown.length - 1)
  );
};

const profileTableLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  const rows = profileTableRows(state, theme);
  const table = managerTable(
    Arr.map(rows, (row) => [row.profile + " ●", row.model, row.effort, row.fallbacks]),
    // The model is what the list is for, so it keeps its width before the reasoning label.
    [
      { minWidth: 12, priority: 5 },
      { minWidth: 8, priority: 4 },
      { minWidth: 7, priority: 3 },
      { minWidth: 11, priority: 1 },
    ],
    width - PROFILE_CURSOR_WIDTH,
  );
  return Arr.map(rows, (row) => {
    const identity =
      row.selected && state.pane === "profiles"
        ? focusedField(theme, row.profile)
        : theme.fg(managerTone.identity, row.profile);
    const marker = state.editedProfiles?.has(row.profile) ? theme.fg("warning", " ●") : "";
    return `${row.selected ? LIST_CURSOR : " "} ${table.row([
      identity + marker,
      row.model,
      row.effort,
      theme.fg("muted", row.fallbacks),
    ])}`;
  });
};

// The editor pane keeps room for its labels and a model route beside the list.
const MIN_EDITOR_WIDTH = 48;
const MIN_LIST_WIDTH = 32;

/** Wide layouts give the list what its models need, and the editor everything else. */
const wideListWidth = (state: ProfileWorkspaceRenderState, theme: Theme, inner: number) => {
  const natural = profileTableNaturalWidth(profileTableRows(state, theme)) + 2;
  const most = Math.max(MIN_LIST_WIDTH, inner - 1 - MIN_EDITOR_WIDTH);
  return Math.max(MIN_LIST_WIDTH, Math.min(natural, most, Math.floor(inner * 0.6)));
};

const profileLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const save = clipToWidth(
    `${state.saveFocused ? LIST_CURSOR : " "} Save these profiles as a set…`,
    width,
  );
  const lines = [
    ...profileTableLines(state, theme, width),
    ...(state.target.kind === "session"
      ? [
          "",
          theme.fg(managerTone.session, theme.bold("Current Session")),
          state.saveFocused && state.pane === "profiles" ? focusedField(theme, save) : save,
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
  if (row.field === "model") return theme.fg(managerTone.value, row.value);
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
  const rows = editorRows(state, profile);
  const labelWidth = Math.max(
    0,
    ...Fn.pipe(
      rows,
      Arr.filter((row) => row.value.length > 0),
      Arr.map((row) => visibleWidth(row.label)),
    ),
  );
  const lines: string[] = [];
  let selectedLine = 0;
  let previousSection: string | undefined;
  Arr.forEach(rows, (row, index) => {
    const section = row.scope === "candidate" ? `candidate:${row.candidateIndex}` : row.scope;
    if (section !== previousSection) {
      if (previousSection !== undefined) lines.push("");
      lines.push(sectionHeading(state, theme, row, profile, width));
      previousSection = section;
    }
    if (index === state.fieldIndex) selectedLine = lines.length;
    const selected = index === state.fieldIndex && state.pane !== "profiles";
    lines.push(fieldLine(state, theme, row, { selected, labelWidth, width }));
  });
  const limit = Math.max(0, height - 1);
  const start = listWindowStart(lines.length, selectedLine, limit);
  return [
    listDetailHeading(theme, profile, state.pane !== "profiles", managerTone.identity),
    ...lines.slice(start, start + limit),
  ];
};

const sectionHeading = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  row: ProfileWorkspaceRow,
  profile: ProfileId,
  width: number,
): string => {
  if (row.scope !== "candidate")
    return theme.fg("muted", "Profile: ") + theme.fg(managerTone.identity, theme.bold(profile));
  const label = profileRouteOptionLabel(row.candidateIndex);
  const candidate = state.draft.candidates[row.candidateIndex];
  const summary =
    candidate === undefined
      ? ""
      : workspaceCandidateSummary(
          candidate,
          profile,
          state.parentEffort,
          Math.max(0, width - visibleWidth(label) - 2),
          state.parentModel,
          theme,
        );
  return theme.fg("muted", theme.bold(`${label}  ${summary}`));
};

const fieldLine = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  row: ProfileWorkspaceRow,
  layout: { readonly selected: boolean; readonly labelWidth: number; readonly width: number },
): string => {
  const { selected, labelWidth, width } = layout;
  const value = row.value
    ? `${Fn.pipe(" ", Str.repeat(Math.max(0, labelWidth - visibleWidth(row.label)) + 2))}${selected && !row.fixed ? row.value : fieldValue(state, theme, row)}`
    : "";
  const text = clipToWidth(
    `${selected ? LIST_CURSOR : " "} ${row.label}${value}${row.scope === "candidate" && row.fixed ? " · fixed" : ""}`,
    width,
  );
  if (selected && !row.fixed) return focusedField(theme, text);
  return row.fixed ? theme.fg("muted", text) : text;
};

const compactLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  if (state.pane === "profiles" && state.saveFocused)
    return [
      theme.fg(managerTone.session, "Current Session"),
      focusedField(theme, "> Save these profiles as a set…"),
    ];
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  const scope =
    state.target.kind === "profile-set" ? `${SCOPE_LABELS[state.target.set.scope]} · ` : "";
  const prefix = `${theme.fg("muted", scope)}${theme.fg(managerTone.identity, profile)} · `;
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
  const selected = editorRows(state, profile)[state.fieldIndex];
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
              ? focusedField(theme, field)
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
  return Arr.flatMap(
    [
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
      "m Model · e Reasoning",
      "a Manage selected candidate · + Add fallback",
      "/ Search profiles",
      "",
      "Changes save automatically to the named editing target.",
      "Undo changes restores this visit's opening profile.",
      `${keys.cancel} or ? closes help`,
    ],
    (line) => wrapTextWithAnsi(line, Math.max(1, width)),
  );
};
const workspaceFooter = (
  state: ProfileWorkspaceRenderState,
  keybindingLabel: ProfileWorkspaceRenderOptions["keybindingLabel"],
  width: number,
): string => {
  const keys = profileWorkspaceKeys(
    keybindingLabel,
    Boolean(state.pendingConfirmation) || state.busy,
  );
  // Aliases such as C-c belong in the help page, not the default hint.
  const cancel = Str.split(keys.cancel, "/")[0] ?? keys.cancel;
  if (state.pendingConfirmation)
    return joinKeyHints([keyHint(keys.confirm, "Confirm"), exitKeyHint("decision", [], cancel)]);
  if (state.helpOpen)
    return joinKeyHints([
      keyHint("↑↓", "Scroll"),
      exitKeyHint("nested", [], cancel),
      helpKeyHint(true),
    ]);
  if (state.busy) return state.cancellableBusy ? keyHint(cancel, "Cancel loading") : "Saving…";
  const top = state.pane === "profiles" && state.target.kind === "session";
  const exit = exitKeyHint(top ? "top" : "nested", [], cancel);
  const tab = keyHint(
    "Tab",
    state.target.kind === "session" ? "Saved profiles" : "Current Session",
  );
  return renderResponsiveManagerFooter(width, [
    [
      keyHint(keys.confirm, "Open"),
      tab,
      keyHint("m", "Model"),
      keyHint("a", "Manage"),
      exit,
      helpKeyHint(false),
    ],
    [tab, exit, helpKeyHint(false)],
    [exit, helpKeyHint(false)],
  ]);
};

export const renderProfileWorkspace = (
  state: ProfileWorkspaceRenderState,
  options: ProfileWorkspaceRenderOptions,
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (!width || !height) return [];
  if (width < 4) return Array.from({ length: height }, () => Fn.pipe(" ", Str.repeat(width)));
  const inner = width - 2;
  const { theme } = options;
  const frame = listDetailFrame(theme, state.pane === "profiles" ? "list" : "detail");
  const context =
    state.target.kind === "session"
      ? "Current Session"
      : qualifiedProfileSetLabel(state.target.set);
  const bottom = workspaceFooter(state, options.keybindingLabel, inner);
  return framedScreen(frame, {
    width,
    height,
    top: theme.fg(
      state.target.kind === "session" ? managerTone.session : managerTone.saved,
      clipToWidth(` ${targetHeading(state.target)} `, inner, ""),
    ),
    bottom: clipToWidth(bottom, inner, ""),
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
          Arr.flatMap([context, confirmation.title, confirmation.detail], (line) =>
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
        notices.push(theme.fg(managerTone.saved, SCOPE_LABELS[state.target.set.scope]));
      if (state.message && state.message.kind !== "success")
        notices.push(
          ...wrapTextWithAnsi(
            theme.fg(managerNoticeColor(state.message.kind), state.message.text),
            inner,
          ).slice(0, 2),
        );
      const available = Math.max(0, bodyHeight - notices.length - 1);
      let body: ReadonlyArray<string>;
      if (managerLayoutTier(width) === "wide") {
        const listWidth = wideListWidth(state, theme, inner);
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
