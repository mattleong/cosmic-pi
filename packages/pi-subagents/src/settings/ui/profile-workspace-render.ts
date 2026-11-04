import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { listWindowStart } from "pi-cosmic-ui/manager/list-detail";
import {
  framedBodyWithHints,
  framedFill,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailHeading,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, LIST_CURSOR, managerTone } from "pi-cosmic-ui/manager/style";
import { managerLayoutTier, managerNoticeColor, clipToWidth } from "pi-cosmic-ui/manager";
import { managerTable } from "pi-cosmic-ui/manager/table";
import {
  borderKeyHint,
  exitKeyHint,
  framedKeyHints,
  helpKeyHint,
  joinKeyHints,
  keyHint,
  keyHintRows,
  moveKeyHint,
  type FramedKeyHints,
} from "pi-cosmic-ui/manager/key-labels";
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
/** Where edits go, shortened rather than clipped when the full sentence doesn't fit. */
const destination = (target: ProfileWorkspaceTarget, width: number): string => {
  const [full, short] =
    target.kind === "session"
      ? [
          "Changes affect later launches. Active runs are unchanged.",
          "Changes affect later launches.",
        ]
      : [
          `Saving to ${qualifiedProfileSetLabel(target.set)} · session not affected`,
          `Saving to ${qualifiedProfileSetLabel(target.set)}`,
        ];
  return visibleWidth(full) <= width ? full : short;
};

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
  readonly fallbacks: number;
  /** Whether this profile changed during the visit, so its row carries the unsaved marker. */
  readonly edited: boolean;
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
      fallbacks: Math.max(0, draft.candidates.length - 1),
      edited: state.editedProfiles?.has(profile) ?? false,
    };
  });

const PROFILE_COLUMN_GAP = 2;
const PROFILE_CURSOR_WIDTH = 2;

// The model is what the list is for, so it keeps its width before the reasoning label.
const PROFILE_COLUMNS = [
  { minWidth: 10, priority: 5 },
  { minWidth: 8, priority: 4 },
  { minWidth: 4, priority: 3 },
  { minWidth: 2, priority: 1 },
] as const;

/** `+1 fallback` where the list has room, and `+1` where the model would otherwise clip. */
const fallbackLabel = (count: number, compact: boolean): string =>
  count === 0 ? "" : compact ? `+${count}` : `+${count} fallback${count === 1 ? "" : "s"}`;

const profileTableCells = (
  row: ProfileTableRow,
  marked: boolean,
  compact: boolean,
): ReadonlyArray<string> => [
  `${row.profile}${marked ? " ●" : ""}`,
  row.model,
  row.effort,
  fallbackLabel(row.fallbacks, compact),
];

/**
 * The width the profile table needs to show every model and fallback count unclipped, measured as
 * the table lays out: each shown column at least its minimum, and empty columns not at all.
 */
const profileTableNaturalWidth = (
  rows: ReadonlyArray<ProfileTableRow>,
  compact = false,
): number => {
  const marked = Arr.some(rows, (row) => row.edited);
  const shown = Arr.filterMap(PROFILE_COLUMNS, (column, index) => {
    const widest = Math.max(
      0,
      ...Arr.map(rows, (row) => visibleWidth(profileTableCells(row, marked, compact)[index] ?? "")),
    );
    return widest === 0 ? Result.failVoid : Result.succeed(Math.max(column.minWidth, widest));
  });
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
  const marked = Arr.some(rows, (row) => row.edited);
  const compact = profileTableNaturalWidth(rows) > width;
  // The shared table leaves out a column with no cells, such as fallbacks when there are none.
  const table = managerTable(
    Arr.map(rows, (row) => profileTableCells(row, marked, compact)),
    PROFILE_COLUMNS,
    width - PROFILE_CURSOR_WIDTH,
  );
  return Arr.map(rows, (row) => {
    const identity =
      row.selected && state.pane === "profiles"
        ? focusedField(theme, row.profile)
        : theme.fg(managerTone.identity, row.profile);
    const marker = row.edited ? theme.fg("warning", " ●") : "";
    return `${row.selected ? LIST_CURSOR : " "} ${table.row([
      identity + marker,
      row.model,
      row.effort,
      theme.fg("muted", fallbackLabel(row.fallbacks, compact)),
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
          listDetailHeading(theme, "Current Session", false, managerTone.session),
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

const EDITOR_GUTTER = "  ";

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
  // Section headings align with the pane's heading, and their fields indent beneath them.
  const headingWidth = Math.max(0, width - EDITOR_GUTTER.length);
  const fieldWidth = Math.max(0, headingWidth - EDITOR_GUTTER.length);
  Arr.forEach(rows, (row, index) => {
    const section = row.scope === "candidate" ? `candidate:${row.candidateIndex}` : row.scope;
    if (section !== previousSection) {
      if (previousSection !== undefined) lines.push("");
      lines.push(EDITOR_GUTTER + sectionHeading(state, theme, row, profile, headingWidth));
      previousSection = section;
    }
    if (index === state.fieldIndex) selectedLine = lines.length;
    const selected = index === state.fieldIndex && state.pane !== "profiles";
    lines.push(
      EDITOR_GUTTER + fieldLine(state, theme, row, { selected, labelWidth, width: fieldWidth }),
    );
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
      focusedField(theme, `${LIST_CURSOR} Save these profiles as a set…`),
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
/** What Enter does on the focused field, or nothing for a fixed one. */
const fieldEnterVerb = (
  state: ProfileWorkspaceRenderState,
  row: ProfileWorkspaceRow | undefined,
): string | undefined => {
  if (!row) return undefined;
  if (row.field === "reset") return "Undo";
  if (row.fixed) return undefined;
  if (row.field === "add" || row.scope === "profile") return "Add";
  if (row.field === "actions") return "Open";
  if (row.field === "advanced")
    return state.expandedCandidates.has(row.candidateIndex) ? "Collapse" : "Expand";
  return "Change";
};

/**
 * The editor's hint bar. Each pane names its own movement and what Enter does; pairs that don't
 * fit the bottom border wrap into rows above it, so the exit and help stay in the border.
 */
const workspaceFooter = (
  state: ProfileWorkspaceRenderState,
  keybindingLabel: ProfileWorkspaceRenderOptions["keybindingLabel"],
  inner: number,
): FramedKeyHints => {
  const keys = profileWorkspaceKeys(
    keybindingLabel,
    Boolean(state.pendingConfirmation) || state.busy,
  );
  // Aliases such as C-c belong in the help page, not the default hint.
  const cancel = Str.split(keys.cancel, "/")[0] ?? keys.cancel;
  const border = (hint: string): FramedKeyHints => ({
    border: borderKeyHint(hint, inner),
    overflow: "",
  });
  if (state.pendingConfirmation)
    return border(
      joinKeyHints([keyHint(keys.confirm, "Confirm"), exitKeyHint("decision", [], cancel)]),
    );
  const move =
    Str.length(keys.up) === 1 && Str.length(keys.down) === 1
      ? `${keys.up}${keys.down}`
      : `${keys.up}/${keys.down}`;
  if (state.helpOpen)
    return border(
      joinKeyHints([keyHint(move, "Scroll"), exitKeyHint("nested", [], cancel), helpKeyHint(true)]),
    );
  if (state.busy)
    return border(state.cancellableBusy ? keyHint(cancel, "Cancel loading") : "Saving…");
  const profiles = state.pane === "profiles";
  const exit = exitKeyHint(
    profiles && state.target.kind === "session" ? "top" : "nested",
    [],
    cancel,
  );
  const enter = profiles
    ? state.saveFocused
      ? "Save"
      : "Open"
    : fieldEnterVerb(state, editorRows(state, selectedProfile(state))[state.fieldIndex]);
  return framedKeyHints(
    [
      moveKeyHint(move),
      enter && keyHint(keys.confirm, enter),
      keyHint("Tab", state.target.kind === "session" ? "Saved profiles" : "Current Session"),
      keyHint("m", "Model"),
      keyHint("a", "Manage"),
    ],
    [exit, helpKeyHint(false)],
    inner,
  );
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
  const footer = workspaceFooter(state, options.keybindingLabel, inner);
  const hints = keyHintRows(footer.overflow, inner, (row) => theme.fg("dim", row));
  return framedScreen(frame, {
    width,
    height,
    top: theme.fg(
      state.target.kind === "session" ? managerTone.session : managerTone.saved,
      clipToWidth(` ${targetHeading(state.target)} `, inner, ""),
    ),
    bottom: footer.border,
    body: (fullHeight) =>
      framedBodyWithHints(frame, { height: fullHeight, inner, hints }, (bodyHeight) =>
        workspaceBody(state, options, frame, { inner, width, bodyHeight, context }),
      ),
  });
};

const workspaceBody = (
  state: ProfileWorkspaceRenderState,
  options: ProfileWorkspaceRenderOptions,
  frame: ReturnType<typeof listDetailFrame>,
  layout: {
    readonly inner: number;
    readonly width: number;
    readonly bodyHeight: number;
    readonly context: string;
  },
): ReadonlyArray<string> => {
  const { theme } = options;
  const { inner, width, bodyHeight, context } = layout;
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
        // Indented with the pane headings above it.
        `  ${theme.fg(
          "muted",
          `${state.message?.kind === "success" ? "✓ Saved · " : ""}${destination(
            state.target,
            inner - 2 - (state.message?.kind === "success" ? 10 : 0),
          )}`,
        )}`,
      ],
      Math.min(1, bodyHeight),
      inner,
    ),
  ];
};
