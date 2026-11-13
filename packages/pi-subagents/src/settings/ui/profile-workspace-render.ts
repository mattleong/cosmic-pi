import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  listWindowPositionLabel,
  listWindowStart,
  stackedListHeight,
  type ListDetailPane,
} from "pi-cosmic-ui/manager/list-detail";
import {
  FRAME_GUTTER,
  listDetailHeading,
  paneHeadingText,
  type ListDetailShell,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, LIST_CURSOR, managerTone } from "pi-cosmic-ui/manager/style";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { managerTable, managerTableNaturalWidth } from "pi-cosmic-ui/manager/table";
import {
  exitKeyHint,
  formatKeyIds,
  framedKeyHintBar,
  joinKeyHints,
  keyHint,
  moveKeyHint,
  type FramedKeyHints,
} from "pi-cosmic-ui/manager/key-labels";
import {
  MAX_PROFILE_CANDIDATES,
  PROFILE_IDS,
  type ProfileId,
  type ProfileCandidate,
} from "../../profiles/model.ts";
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
  candidateModelLabel,
  profileWorkspaceRows,
  type ProfileWorkspaceRow,
} from "./profile-workspace-model.ts";
import type {
  SearchableSelectHostOptions,
  SearchableSelectPage,
} from "pi-cosmic-ui/manager/searchable-select";
import { profileWorkspaceKeys } from "./profile-workspace-keys.ts";
import type { DashboardPrompt } from "./profile-dashboard-render.ts";
import { renderTwoPaneFrame } from "./two-pane-frame.ts";
import { countLabel } from "pi-cosmic-core/display";

export interface ProfileWorkspaceConfirmation {
  readonly title: string;
  readonly detail: string;
  /** The verb Enter performs, such as `Remove`. */
  readonly verb: string;
}
interface ProfileWorkspaceRenderState {
  readonly inspection: ProfileSettingsInspection;
  readonly target: ProfileWorkspaceTarget;
  readonly parentEffort: SubagentEffort;
  readonly parentModel?: string | undefined;
  /** Pane focus, the profile selection, and the arrangement. */
  readonly shell: ListDetailShell;
  readonly candidateIndex: number;
  readonly fieldIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly expandedCandidates: ReadonlySet<number>;
  /** Profiles whose session route no set holds, marked `●`. */
  readonly changedProfiles: ReadonlySet<ProfileId>;
  /** Whether `u` can undo the selected profile's changes from this visit. */
  readonly canUndo: boolean;
  /** `?` expanded the hint bar to every key the editor takes. */
  readonly hintsExpanded?: boolean | undefined;
  readonly busy: boolean;
  /** A short choice list, drawn in the fields pane. */
  readonly choices?: Pick<SearchableSelectPage<unknown>, "renderBody" | "keyHints"> | undefined;
  readonly confirmation?: ProfileWorkspaceConfirmation | undefined;
  /** A host's pending decision, such as saving the session as a set, in a band above the border. */
  readonly prompt?: DashboardPrompt | undefined;
}
interface ProfileWorkspaceRenderOptions {
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  /** The whole surface's height, which with the width decides how panes are arranged. */
  readonly frameHeight: number;
  readonly keybindingLabel?: SearchableSelectHostOptions["keybindingLabel"];
}
const selectedProfile = (state: ProfileWorkspaceRenderState): ProfileId =>
  PROFILE_IDS[state.shell.state.selected] ?? PROFILE_IDS[0];
const editorRows = (state: ProfileWorkspaceRenderState, profile: ProfileId) =>
  profileWorkspaceRows(
    state.draft,
    profile,
    state.parentEffort,
    state.parentModel,
    state.expandedCandidates,
  );
const focusedPane = (state: ProfileWorkspaceRenderState): ListDetailPane =>
  state.choices ? "detail" : state.shell.state.pane;

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
    ? `${theme.fg(managerTone.value, clipToWidth(fittedModelLabel(candidate, parentModel, modelWidth), modelWidth))} · ${metadata}`
    : clipToWidth(metadata, width);
};

/** An inherited model drops its provider before it would clip: `inherit (claude-opus-5-5)`. */
const fittedModelLabel = (
  candidate: ProfileCandidate,
  parentModel: string | undefined,
  width: number,
): string => {
  const full = candidateModelLabel(candidate, parentModel);
  return visibleWidth(full) <= width ? full : candidateModelLabel(candidate, parentModel, true);
};

// Inherited values are drawn dimmer than pinned ones, so what a profile pins stands out.
const INHERITED_TONE = "dim";

interface ProfileTableRow {
  readonly profile: ProfileId;
  readonly selected: boolean;
  readonly model: string;
  /** The reasoning label, `inherit (low)` where the profile doesn't pin one. */
  readonly effort: string;
  /** The bare level a narrow list shows instead, such as `low`. */
  readonly shortEffort: string;
  readonly fallbacks: number;
  /** Whether no saved set holds this profile's route, so its row carries `●`. */
  readonly changed: boolean;
}

const profileTableRows = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
): ReadonlyArray<ProfileTableRow> =>
  Arr.map(PROFILE_IDS, (profile, index) => {
    const selected = index === state.shell.state.selected;
    const draft = selected
      ? state.draft
      : loadProfileRouteDraft(state.inspection, state.target, profile);
    const first = draft.kind === "invalid" ? undefined : draft.candidates[0];
    const fast =
      first && candidateFastModeApplied(first, state.parentModel) ? theme.fg("warning", " ⚡") : "";
    const effortTone = first?.effort === "default" ? INHERITED_TONE : "text";
    return {
      profile,
      selected,
      model: theme.fg(
        first
          ? first.model === "parent"
            ? INHERITED_TONE
            : managerTone.value
          : draft.kind === "invalid"
            ? "error"
            : "muted",
        first
          ? candidateModelLabel(first, state.parentModel, true)
          : draft.kind === "invalid"
            ? "invalid"
            : "disabled",
      ),
      // An inherited level reads `inherit (low)` like the editor pane, unless the list is narrow.
      effort: first
        ? `${theme.fg(effortTone, candidateEffortLabel(profile, first, state.parentEffort))}${fast}`
        : "",
      shortEffort: first
        ? `${theme.fg(effortTone, candidateEffortLevel(profile, first, state.parentEffort))}${fast}`
        : "",
      fallbacks: Math.max(0, draft.candidates.length - 1),
      changed: state.changedProfiles.has(profile),
    };
  });

const PROFILE_CURSOR_WIDTH = 2;

// The model is what the list is for, so it keeps its width before the reasoning label.
const PROFILE_COLUMNS = [
  { minWidth: 10, priority: 5, header: "Profile" },
  { minWidth: 8, priority: 4, header: "Model" },
  { minWidth: 4, priority: 3, header: "Reasoning" },
  { minWidth: 2, priority: 1 },
] as const;
const UNHEADED_PROFILE_COLUMNS = Arr.map(PROFILE_COLUMNS, ({ minWidth, priority }) => ({
  minWidth,
  priority,
}));

/**
 * `+1 fallback` in its own column where the list has room. Where the model would otherwise clip,
 * a bare `+1` follows the reasoning label instead, saving the column gap.
 */
const fallbackLabel = (count: number, compact: boolean): string =>
  count === 0 ? "" : compact ? `+${count}` : `+${countLabel(count, "fallback")}`;

/**
 * How much a list gives up to keep its models whole: first the fallback column, which becomes a
 * bare `+1`, then `inherit (…)` around an inherited reasoning level.
 */
type ProfileTableFit = "full" | "compact" | "short";

const effortCell = (row: ProfileTableRow, fallbacks: string, fit: ProfileTableFit): string => {
  const effort = fit === "short" ? row.shortEffort : row.effort;
  return fit !== "full" && fallbacks ? `${effort} ${fallbacks}` : effort;
};

const profileTableCells = (
  row: ProfileTableRow,
  marked: boolean,
  fit: ProfileTableFit,
): ReadonlyArray<string> => {
  const fallbacks = fallbackLabel(row.fallbacks, fit !== "full");
  return [
    `${row.profile}${marked ? " ●" : ""}`,
    row.model,
    effortCell(row, fallbacks, fit),
    fit === "full" ? fallbacks : "",
  ];
};

/**
 * The width the profile table needs to show every model and fallback count unclipped, measured as
 * the table lays out: each shown column at least its minimum, and empty columns not at all. Column
 * headings count only when `headed`; where one doesn't fit, it is left out.
 */
const profileTableNaturalWidth = (
  rows: ReadonlyArray<ProfileTableRow>,
  fit: ProfileTableFit = "full",
  headed = false,
  marked = Arr.some(rows, (row) => row.changed),
): number =>
  PROFILE_CURSOR_WIDTH +
  managerTableNaturalWidth(
    Arr.map(rows, (row) => profileTableCells(row, marked, fit)),
    headed ? PROFILE_COLUMNS : UNHEADED_PROFILE_COLUMNS,
  );

const profileTable = (state: ProfileWorkspaceRenderState, theme: Theme, width: number) => {
  const rows = profileTableRows(state, theme);
  const marked = Arr.some(rows, (row) => row.changed);
  // The fallback count moves beside the reasoning before the headings go, and the headings go
  // before an inherited level loses its `inherit (…)`.
  const layouts = [
    { fit: "full", headed: true },
    { fit: "compact", headed: true },
    { fit: "compact", headed: false },
    { fit: "short", headed: true },
    { fit: "short", headed: false },
  ] as const;
  const { fit, headed } = Option.getOrElse(
    Arr.findFirst(
      layouts,
      (layout) => profileTableNaturalWidth(rows, layout.fit, layout.headed) <= width,
    ),
    () => ({ fit: "short" as const, headed: false }),
  );
  const compact = fit !== "full";
  const listFocused = focusedPane(state) === "list" && !state.prompt && !state.confirmation;
  // The shared table leaves out a column with no cells, such as fallbacks when there are none.
  const table = managerTable(
    Arr.map(rows, (row) => profileTableCells(row, marked, fit)),
    headed ? PROFILE_COLUMNS : UNHEADED_PROFILE_COLUMNS,
    width - PROFILE_CURSOR_WIDTH,
  );
  return {
    header:
      table.header === undefined
        ? undefined
        : theme.fg("muted", `${Fn.pipe(" ", Str.repeat(PROFILE_CURSOR_WIDTH))}${table.header}`),
    rows: Arr.map(rows, (row) => {
      const identity =
        row.selected && listFocused
          ? focusedField(theme, row.profile)
          : theme.fg(managerTone.identity, row.profile);
      const marker = row.changed ? theme.fg("warning", " ●") : "";
      const label = fallbackLabel(row.fallbacks, compact);
      const fallbacks = label ? theme.fg("muted", label) : "";
      return `${row.selected ? LIST_CURSOR : " "} ${table.row([
        identity + marker,
        row.model,
        effortCell(row, fallbacks, fit),
        compact ? "" : fallbacks,
      ])}`;
    }),
  };
};

// The editor pane keeps room for its labels and a model route beside the list.
const MIN_EDITOR_WIDTH = 48;
const MIN_LIST_WIDTH = 32;

/** Wide layouts give the list what its models need, and the editor everything else. */
const wideListWidth = (state: ProfileWorkspaceRenderState, theme: Theme, inner: number) => {
  // Room for the `●` marker is always kept, so the panes don't shift when an edit adds one.
  const natural =
    profileTableNaturalWidth(profileTableRows(state, theme), "full", true, true) + 2 * FRAME_GUTTER;
  const most = Math.max(MIN_LIST_WIDTH, inner - 1 - MIN_EDITOR_WIDTH);
  return Math.max(MIN_LIST_WIDTH, Math.min(natural, most, Math.floor(inner * 0.6)));
};

/** Lines the profile pane draws when every row shows: its heading, column headings, and rows. */
const PROFILE_PANE_LINES = PROFILE_IDS.length + 2;

/** The profile pane: its heading with the rows scrolled off, column headings, and the rows. */
const profileLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const table = profileTable(state, theme, width);
  const header = height >= 3 && table.header !== undefined ? [table.header] : [];
  const window = state.shell.visibleWindow(
    table.rows.length,
    Math.max(1, height - 1 - header.length),
  );
  const focused = focusedPane(state) === "list" && !state.prompt && !state.confirmation;
  return [
    listDetailHeading(
      theme,
      paneHeadingText("Profiles", listWindowPositionLabel(window, table.rows.length), width),
      focused,
    ),
    ...header,
    ...table.rows.slice(window.start, window.end),
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
  if (row.field === "model")
    return theme.fg(candidate?.model === "parent" ? INHERITED_TONE : managerTone.value, row.value);
  if (row.field === "openaiFastMode" && candidate?.openaiFastMode)
    return theme.fg("warning", row.value);
  return theme.fg(
    row.field === "effort" && candidate?.effort === "default" ? INHERITED_TONE : "text",
    row.value,
  );
};

const EDITOR_GUTTER = "  ";

/**
 * The fields pane: the selected profile's settings under a heading per candidate, windowed around
 * the field cursor, with the rows scrolled off named in the pane heading.
 */
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
  const fieldsFocused = focusedPane(state) === "detail" && !state.prompt && !state.confirmation;
  const lines: string[] = [];
  // The row each line draws, so the heading can count the rows scrolled off.
  const lineRows: Array<number | undefined> = [];
  let selectedLine = 0;
  let previousSection: number | undefined;
  const fieldWidth = Math.max(0, width - EDITOR_GUTTER.length);
  Arr.forEach(rows, (row, index) => {
    if (row.scope === "candidate" && row.candidateIndex !== previousSection) {
      if (previousSection !== undefined) {
        lines.push("");
        lineRows.push(undefined);
      }
      lines.push(
        EDITOR_GUTTER + theme.fg("muted", theme.bold(profileRouteOptionLabel(row.candidateIndex))),
      );
      // A heading draws no row, so the pane heading's position counts fields only.
      lineRows.push(undefined);
      previousSection = row.candidateIndex;
    }
    if (index === state.fieldIndex) selectedLine = lines.length;
    const selected = index === state.fieldIndex && state.shell.state.pane === "detail";
    lines.push(
      EDITOR_GUTTER +
        fieldLine(state, theme, row, {
          selected,
          focused: fieldsFocused,
          labelWidth,
          width: fieldWidth,
        }),
    );
    lineRows.push(index);
  });
  const sectionHeading = (line: number) => {
    const row = rows[lineRows[line] ?? -1];
    return row?.scope === "candidate"
      ? EDITOR_GUTTER + theme.fg("muted", theme.bold(profileRouteOptionLabel(row.candidateIndex)))
      : undefined;
  };
  const limit = Math.max(1, height - 1);
  const window = (size: number) => {
    const start = listWindowStart(lines.length, selectedLine, size);
    return { start, end: start + size };
  };
  // A window that starts among a candidate's fields keeps that candidate's heading on top.
  const plain = window(limit);
  const narrower = window(limit - 1);
  const sticky =
    plain.start > 0 && limit > 1 && lineRows[plain.start] !== undefined
      ? sectionHeading(narrower.start)
      : undefined;
  const shown = sticky === undefined ? plain : narrower;
  const visible = [
    ...(sticky === undefined ? [] : [sticky]),
    ...lines.slice(shown.start, shown.end),
  ];
  const shownRows = Arr.filter(lineRows.slice(shown.start, shown.end), Predicate.isNotUndefined);
  const position =
    lines.length > limit
      ? listWindowPositionLabel(
          { start: shownRows[0] ?? 0, end: (shownRows.at(-1) ?? -1) + 1 },
          rows.length,
        )
      : undefined;
  return [
    listDetailHeading(
      theme,
      paneHeadingText(profile, position, width),
      fieldsFocused,
      managerTone.identity,
    ),
    ...visible,
  ];
};

const fieldLine = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  row: ProfileWorkspaceRow,
  layout: {
    readonly selected: boolean;
    readonly focused: boolean;
    readonly labelWidth: number;
    readonly width: number;
  },
): string => {
  const { selected, focused, labelWidth, width } = layout;
  const gap = Math.max(0, labelWidth - visibleWidth(row.label)) + 2;
  const candidate =
    row.scope === "candidate" && row.field === "model"
      ? state.draft.candidates[row.candidateIndex]
      : undefined;
  // `LIST_CURSOR`, a space, the label, and the gap come before the value.
  const shown = candidate
    ? {
        ...row,
        value: fittedModelLabel(
          candidate,
          state.parentModel,
          width - 2 - visibleWidth(row.label) - gap,
        ),
      }
    : row;
  const highlighted = selected && focused && !row.fixed;
  const value = shown.value
    ? `${Fn.pipe(" ", Str.repeat(gap))}${highlighted ? shown.value : fieldValue(state, theme, shown)}`
    : "";
  const text = clipToWidth(
    `${selected ? LIST_CURSOR : " "} ${row.label}${value}${row.scope === "candidate" && row.fixed ? " · fixed" : ""}`,
    width,
  );
  if (highlighted) return focusedField(theme, text);
  return row.fixed ? theme.fg("muted", text) : text;
};

/** A body too short for panes shows the selected profile and field on one or two lines. */
const compactLines = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
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
  const fields = state.shell.state.pane === "detail";
  const field = selected
    ? `${selected.label}  ${fields && !selected.fixed ? selected.value : fieldValue(state, theme, selected)}`
    : "";
  return [
    prefix + summary,
    ...(selected
      ? [selected.fixed ? theme.fg("muted", field) : fields ? focusedField(theme, field) : field]
      : []),
  ];
};

/** What Enter does on the focused field, or nothing for a fixed one. */
const fieldEnterVerb = (
  state: ProfileWorkspaceRenderState,
  row: ProfileWorkspaceRow | undefined,
): string | undefined => {
  if (!row || row.fixed) return undefined;
  if (row.scope === "profile") return "Add";
  if (row.field === "advanced")
    return state.expandedCandidates.has(row.candidateIndex) ? "Collapse" : "Expand";
  return "Change";
};

/**
 * The editor's hint bar. Each pane names its own movement and what Enter does; pairs that don't
 * fit the bottom border wrap into rows above it, so the exit and help stay in the border. `q`
 * backs out one level like Esc, so expanded help names it in the exit pair.
 */
const workspaceFooter = (
  state: ProfileWorkspaceRenderState,
  keybindingLabel: ProfileWorkspaceRenderOptions["keybindingLabel"],
  inner: number,
): FramedKeyHints => {
  const keys = profileWorkspaceKeys(keybindingLabel, state.busy);
  // Aliases such as C-c belong in the expanded bar, not the default one.
  const { cancel, cancelAliases } = keys;
  // No key answers while a change is being written.
  if (state.busy) return { border: "", overflow: "" };
  const profiles = state.shell.state.pane === "list";
  const enter = profiles
    ? "Open"
    : fieldEnterVerb(state, editorRows(state, selectedProfile(state))[state.fieldIndex]);
  const count = state.draft.candidates.length;
  const hasCandidate = state.draft.candidates[state.candidateIndex] !== undefined;
  const session = state.target.kind === "session";
  const other = session ? "Saved profiles" : "Current session";
  const save = session && keyHint("s", "Save as set");
  // Saving is worth offering by default once the session differs from the set it is based on.
  const sessionChanged = state.changedProfiles.size > 0;
  return framedKeyHintBar(
    {
      hints: [
        moveKeyHint(keys.move),
        enter && keyHint(keys.confirm, enter),
        keyHint("m", "Model"),
        hasCandidate && keyHint("a", "Manage"),
        count > 0 && count < MAX_PROFILE_CANDIDATES && keyHint("+", "Add fallback"),
        state.canUndo && keyHint("u", "Undo"),
        sessionChanged && save,
        keyHint("Tab", other),
      ],
      // The expanded bar keeps every default pair and adds the rest of the editor's keys.
      more: [
        keyHint("j/k", "Move"),
        keyHint("←→", "Pane"),
        keyHint("h/l", "Pane"),
        keyHint(formatKeyIds(["shift+tab"]), other),
        count > 1 && keyHint("[ ]", "Candidate"),
        hasCandidate && keyHint("e", "Reasoning"),
        profiles && keyHint("/", "Search"),
        !sessionChanged && save,
      ],
      exit: profiles && session ? "top" : "nested",
      exitKey: cancel,
      exitAliases: [...cancelAliases, "q"],
    },
    state.hintsExpanded === true,
    inner,
  );
};

/** The editor's own confirmation as a prompt band; the border names the decision keys. */
const confirmationPrompt = (
  confirmation: ProfileWorkspaceConfirmation,
  theme: Theme,
  keybindingLabel: ProfileWorkspaceRenderOptions["keybindingLabel"],
): DashboardPrompt => {
  const keys = profileWorkspaceKeys(keybindingLabel, true);
  return {
    text: `${theme.fg("warning", theme.bold(confirmation.title))}\n${theme.fg("warning", confirmation.detail)}`,
    hint: joinKeyHints([
      keyHint(keys.confirm, confirmation.verb),
      exitKeyHint("decision", [], keys.cancel),
    ]),
  };
};

export const renderProfileWorkspace = (
  state: ProfileWorkspaceRenderState,
  options: ProfileWorkspaceRenderOptions,
): string[] => {
  const { theme } = options;
  // The fields pane, or the choice list open in its place.
  const detail = (text: number, height: number) =>
    state.choices
      ? state.choices.renderBody(text, height)
      : editorLines(state, theme, text, height);
  return renderTwoPaneFrame({
    theme,
    width: options.width,
    height: options.height,
    frameHeight: options.frameHeight,
    shell: state.shell,
    hasSelection: true,
    focusedPane: () => focusedPane(state),
    prompt:
      state.prompt ??
      (state.confirmation
        ? confirmationPrompt(state.confirmation, theme, options.keybindingLabel)
        : undefined),
    page: state.choices,
    footer: (inner) => workspaceFooter(state, options.keybindingLabel, inner),
    columns: (inner) => {
      const listWidth = wideListWidth(state, theme, inner);
      return { listWidth, detailWidth: inner - listWidth - 1 };
    },
    compact: (text) => compactLines(state, theme, text),
    stackedListHeight: (bodyHeight) => stackedListHeight(bodyHeight, PROFILE_PANE_LINES),
    singleShowsDetail: false,
    list: (text, height) => profileLines(state, theme, text, height),
    detail,
  });
};
