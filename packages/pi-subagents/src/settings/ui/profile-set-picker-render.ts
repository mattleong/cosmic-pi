import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clipToWidth, joinInline, SUITE_STATUS_GLYPHS, wrapFacts } from "pi-cosmic-ui/manager";
import { managerTable, managerTableNaturalWidth } from "pi-cosmic-ui/manager/table";
import {
  configuredKeyLabels,
  framedKeyHintBar,
  framedKeyHints,
  keyHint,
  moveKeyHint,
  type FramedKeyHints,
} from "pi-cosmic-ui/manager/key-labels";
import {
  detailWindowPositionLabel,
  listWindowPositionLabel,
  stackedListHeight,
  wideListDetailGeometry,
  type DetailWindowPosition,
  type ListDetailPane,
} from "pi-cosmic-ui/manager/list-detail";
import {
  listDetailHeading,
  paneHeadingText,
  type ListDetailShell,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, LIST_CURSOR, managerTone } from "pi-cosmic-ui/manager/style";
import type {
  SearchableSelectHostOptions,
  SearchableSelectPage,
} from "pi-cosmic-ui/manager/searchable-select";
import { profileRouteOptionLabel, SCOPE_LABELS } from "../profile-route-editor.ts";
import type { ProfileRouteSource } from "../../profiles/model.ts";
import type { SubagentConfigScope } from "../../config/store.ts";
import {
  ownSource,
  profileSourceLabel,
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
  type SelectableProfileSetEntry,
} from "./profile-set-picker-model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  candidateEffortLabel,
  candidateEffortLevel,
  candidateModelLabel,
} from "./profile-workspace-model.ts";
import type { DashboardPrompt } from "./profile-dashboard-render.ts";
import { renderTwoPaneFrame } from "./two-pane-frame.ts";

interface ProfileSetPickerRenderState {
  /** The entries the filter keeps, scope notes included, in display order. */
  readonly entries: ReadonlyArray<ProfileSetPickerEntry>;
  readonly selected: SelectableProfileSetEntry | undefined;
  /** Pane focus, the selection among selectable entries, preview scrolling, and arrangement. */
  readonly shell: ListDetailShell;
  readonly previewFollow: DetailWindowPosition;
  readonly query: string;
  readonly searching: boolean;
  /** `?` expanded the hint bar to every key the picker takes. */
  readonly hintsExpanded?: boolean | undefined;
  readonly parentModel?: string | undefined;
  readonly parentEffort?: SubagentEffort | undefined;
  /** The selected set's Actions menu, drawn in the preview pane. */
  readonly menu?: Pick<SearchableSelectPage<unknown>, "renderBody" | "keyHints"> | undefined;
  /** A host's pending decision in a band above the border; the panes above stay in view. */
  readonly prompt?: DashboardPrompt | undefined;
}

interface ProfileSetPickerRenderOptions extends Pick<
  SearchableSelectHostOptions,
  "keybindingLabel"
> {
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  /** The whole surface's height, which with the width decides how panes are arranged. */
  readonly frameHeight: number;
}

export const PROFILE_SET_SHORTCUTS: ReadonlySet<string> = new Set(["/", "a", "u"]);

const focusedPane = (state: ProfileSetPickerRenderState): ListDetailPane =>
  state.menu ? "detail" : state.searching ? "list" : state.shell.state.pane;

/**
 * Pairs that don't fit the bottom border wrap into rows above it, so Move, Edit, and the exit
 * stay visible at every width. Each pane names its own movement: the list moves the selection,
 * the preview scrolls.
 */
const footer = (
  state: ProfileSetPickerRenderState,
  inner: number,
  keybindingLabel: SearchableSelectHostOptions["keybindingLabel"],
): FramedKeyHints => {
  const keys = configuredKeyLabels(keybindingLabel, PROFILE_SET_SHORTCUTS);
  const confirm = keys.primary("tui.select.confirm", "Enter");
  const move = moveKeyHint(keys.movement);
  // Aliases such as C-c belong in expanded help, not the default hint.
  const { key: cancel, aliases: cancelAliases } = keys.binding("tui.select.cancel", "Esc");
  const any = state.selected !== undefined;
  if (state.searching)
    return framedKeyHints(
      ["Type to filter", any && move, any && keyHint(confirm, "Edit")],
      [keyHint(cancel, "Clear")],
      inner,
    );
  const preview = state.shell.state.pane === "detail";
  const actions = [
    any && keyHint(confirm, "Edit"),
    any && keyHint("u", "Use"),
    any && keyHint("a", "Actions"),
  ];
  return framedKeyHintBar(
    preview
      ? {
          hints: [
            keyHint(keys.movement ?? "↑↓", "Scroll"),
            ...actions,
            keyHint("Tab", "Current session"),
          ],
          more: [keyHint("j/k", "Scroll"), keyHint("q", "Close")],
          exit: "nested",
          exitKey: cancel,
          exitAliases: [...cancelAliases, "h"],
        }
      : {
          hints: [
            any && move,
            ...actions,
            keyHint("/", "Filter"),
            any && keyHint("→", "Preview"),
            keyHint("Tab", "Current session"),
          ],
          more: [any && keyHint("j/k", "Move"), any && keyHint("l", "Preview")],
          exit: "top",
          exitKey: cancel,
          exitAliases: [...cancelAliases, "q"],
        },
    state.hintsExpanded === true,
    inner,
  );
};

// Sets sit under their scope's heading; the selected set's description hangs under its name.
const ENTRY_INDENT = "  ";
const NOTE_INDENT = "    ";
const DESCRIPTION_INDENT = "      ";

interface LibraryLine {
  readonly text: string;
  readonly scope: SubagentConfigScope;
  /** The selectable entry this line belongs to, if any. */
  readonly entry?: number | undefined;
  readonly heading?: boolean | undefined;
}

const flagged = (entry: SelectableProfileSetEntry): boolean =>
  entry.kind === "invalid-default" || entry.invalid;

const entryBadges = (theme: Theme, entry: SelectableProfileSetEntry): string =>
  `${entry.scopeDefault ? theme.fg("muted", " · default") : ""}${
    entry.kind === "set" && entry.inUse ? theme.fg("muted", " · in use") : ""
  }${
    flagged(entry)
      ? theme.fg(
          "error",
          ` · ${SUITE_STATUS_GLYPHS.warning} ${entry.kind === "set" ? "fix profiles" : "clear"}`,
        )
      : ""
  }`;

const scopeHeading = (theme: Theme, scope: SubagentConfigScope): string =>
  theme.fg("muted", theme.bold(SCOPE_LABELS[scope]));

/** Every line of the list: scope headings, muted notes, sets, and the selected set's description. */
const libraryLines = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<LibraryLine> => {
  const lines: LibraryLine[] = [];
  const listFocused = focusedPane(state) === "list" && !state.prompt;
  let scope: SubagentConfigScope | undefined;
  let index = 0;
  for (const entry of state.entries) {
    if (entry.scope !== scope) {
      scope = entry.scope;
      lines.push({ text: scopeHeading(theme, entry.scope), scope: entry.scope, heading: true });
    }
    if (entry.kind === "scope-note") {
      // A note says what would appear here; it can't be selected, so it never looks like a set.
      for (const line of wrapTextWithAnsi(
        entry.key === "project:locked" ? entry.description : entry.label,
        Math.max(1, width - NOTE_INDENT.length),
      ))
        lines.push({ text: NOTE_INDENT + theme.fg("dim", line), scope: entry.scope });
      continue;
    }
    const selected = entry === state.selected;
    const label =
      selected && listFocused
        ? focusedField(theme, entry.label)
        : theme.fg(managerTone.saved, entry.label);
    // The selected row's description states the default and the problem, so its badges don't.
    lines.push({
      entry: index,
      scope: entry.scope,
      text: clipToWidth(
        `${ENTRY_INDENT}${selected ? LIST_CURSOR : " "} ${label}${selected ? "" : entryBadges(theme, entry)}`,
        width,
      ),
    });
    if (selected)
      for (const line of wrapTextWithAnsi(
        entry.description,
        Math.max(1, width - DESCRIPTION_INDENT.length),
      ))
        lines.push({
          entry: index,
          scope: entry.scope,
          text: DESCRIPTION_INDENT + theme.fg(flagged(entry) ? "error" : "muted", line),
        });
    index += 1;
  }
  return lines;
};

/**
 * The list pane, windowed around the selected set. Headings and notes travel with the set after
 * them (the last set keeps any after it), so the window never strands a heading without its sets.
 */
const libraryRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const search = state.searching
    ? [ENTRY_INDENT + theme.fg("accent", `Search /${state.query}`)]
    : [];
  const lines = libraryLines(state, theme, width);
  const count = Arr.reduce(lines, 0, (total, line) =>
    line.entry === undefined ? total : Math.max(total, line.entry + 1),
  );
  const limit = Math.max(1, height - 1 - search.length);
  const owner = (position: number): number => {
    for (let next = position; next < lines.length; next += 1) {
      const entry = lines[next]?.entry;
      if (entry !== undefined) return entry;
    }
    return Math.max(0, count - 1);
  };
  const owners = Arr.map(lines, (_, position) => owner(position));
  const heights = Arr.makeBy(count, (entry) => Arr.filter(owners, (each) => each === entry).length);
  const windowed = (rows: number) => {
    const window =
      count > 0 ? state.shell.visibleWindow(count, rows, heights) : { start: 0, end: 0 };
    const shown =
      count > 0
        ? Arr.filter(lines, (_, position) => {
            const each = owners[position] ?? 0;
            return each >= window.start && each < window.end;
          })
        : lines.slice(0, rows);
    return { window, shown };
  };
  const first = windowed(limit);
  // A window that starts inside a scope keeps that scope's heading on its first line.
  const [top] = first.shown;
  const { window, shown } =
    top && !top.heading && limit > 1
      ? (() => {
          const narrower = windowed(limit - 1);
          const scope = narrower.shown[0]?.scope ?? top.scope;
          return {
            window: narrower.window,
            shown: [{ text: scopeHeading(theme, scope), scope, heading: true }, ...narrower.shown],
          };
        })()
      : first;
  const focused = focusedPane(state) === "list" && !state.prompt;
  return [
    listDetailHeading(
      theme,
      paneHeadingText("Saved profile sets", listWindowPositionLabel(window, count), width),
      focused,
      managerTone.saved,
    ),
    ...search,
    ...Arr.map(shown.slice(0, limit), (line) => line.text),
  ];
};

/** How a profile reaches the set: `set here` when the set declares it, else where it comes from. */
const provenance = (scope: SubagentConfigScope, source: ProfileRouteSource): string =>
  ownSource(scope, source) ? "set here" : profileSourceLabel(source);

/** The provenance most profiles share, stated once; a row that differs carries its own. */
const commonProvenance = (labels: ReadonlyArray<string>): string => {
  const count = (label: string) => Arr.filter(labels, (each) => each === label).length;
  return Arr.reduce(Arr.dedupe(labels), "", (best, label) =>
    best === "" || count(label) > count(best) ? label : best,
  );
};

type PreviewFit = "full" | "short" | "unlabelled";
const PREVIEW_FITS = ["full", "short", "unlabelled"] as const satisfies ReadonlyArray<PreviewFit>;

// An empty column, such as Primary when no profile has a fallback, takes no space.
const PREVIEW_COLUMNS = [
  { minWidth: 10, priority: 5 },
  { minWidth: 7, priority: 2 },
  { minWidth: 16, priority: 4 },
  { minWidth: 4, priority: 3 },
] as const;
/** A fit is chosen by the width its cells need to show whole, before any column's minimum. */
const PREVIEW_CELL_WIDTHS = Arr.map(PREVIEW_COLUMNS, () => ({ minWidth: 0 }));

/** Every line of the selected set's preview, which the shell windows and scrolls. */
const previewLines = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  const entry = state.selected;
  const wrapped = (text: string, tone: Parameters<Theme["fg"]>[0]) =>
    Arr.map(wrapTextWithAnsi(text, Math.max(1, width)), (line) => theme.fg(tone, line));
  if (!entry)
    return state.query
      ? wrapped("No saved sets match this search.", "muted")
      : wrapped("Save the current session as a set from the Current session tab.", "muted");
  if (entry.kind !== "set") return wrapped(entry.description, "error");
  const labels = Arr.map(entry.preview, (profile) => provenance(entry.scope, profile.source));
  const common = commonProvenance(labels);
  // Where the profiles come from, said once: the profiles that differ by name, then the rest.
  const differing = Arr.dedupe(Arr.filter(labels, (label) => label !== common));
  const note = differing.length
    ? joinInline([
        ...Arr.map(differing, (label) => {
          const names = Arr.filterMap(entry.preview, (profile, index) =>
            labels[index] === label ? Result.succeed(profile.id) : Result.failVoid,
          );
          return `${Arr.join(names, ", ")} ${label}`;
        }),
        `others ${common}`,
      ])
    : `All ${common === "set here" ? "profiles set here" : common}`;
  const fallbacks = Arr.some(entry.preview, (profile) => profile.candidates.length > 1);
  const parentEffort = state.parentEffort;
  // A narrow pane gives up `inherit (…)` around a reasoning level, then the candidate labels,
  // before it clips a model.
  const rowsAt = (fit: PreviewFit) =>
    Arr.flatMap(entry.preview, (profile) => {
      const identity = theme.fg(managerTone.identity, profile.id);
      if (profile.status !== "configured")
        return [
          [
            identity,
            "",
            theme.fg(profile.status === "invalid" ? "error" : "muted", profile.status),
            "",
          ],
        ];
      return Arr.map(profile.candidates, (candidate, index) => [
        index === 0 ? identity : "",
        fallbacks && fit !== "unlabelled" ? theme.fg("muted", profileRouteOptionLabel(index)) : "",
        `${theme.fg(
          candidate.model === "parent" ? "dim" : managerTone.value,
          candidateModelLabel(candidate, state.parentModel, true),
        )}${candidate.openaiFastMode ? theme.fg("warning", " ⚡") : ""}`,
        theme.fg(
          candidate.effort === "default" ? "dim" : "text",
          parentEffort === undefined
            ? candidate.effort === "default"
              ? "inherit"
              : candidate.effort
            : fit === "full"
              ? candidateEffortLabel(profile.id, candidate, parentEffort)
              : candidateEffortLevel(profile.id, candidate, parentEffort),
        ),
      ]);
    });
  const rows = Option.getOrElse(
    Arr.findFirst(
      Arr.map(PREVIEW_FITS, rowsAt),
      (candidate) => managerTableNaturalWidth(candidate, PREVIEW_CELL_WIDTHS) <= width,
    ),
    () => rowsAt("unlabelled"),
  );
  const table = managerTable(rows, PREVIEW_COLUMNS, width);
  return [
    ...Arr.map(wrapFacts(note, width), (line) => theme.fg("muted", line)),
    ...Arr.map(rows, table.row),
  ];
};

/** The preview pane: the selected set's name, the lines its rows scroll through, and the rows. */
const previewRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  if (state.menu) return state.menu.renderBody(width, height);
  const lines = previewLines(state, theme, width);
  // The heading carries the position, so an overflowing window needs no line of its own for it.
  const room = Math.max(1, height - 1);
  const window = state.shell.detailWindow(
    lines,
    lines.length > room + 1 ? room + 1 : room,
    state.previewFollow,
  );
  const title =
    state.selected?.kind === "set"
      ? qualifiedProfileSetLabel(state.selected.ref)
      : state.selected
        ? `${SCOPE_LABELS[state.selected.scope]} default`
        : "Preview";
  return [
    listDetailHeading(
      theme,
      paneHeadingText(
        title,
        window.overflow ? detailWindowPositionLabel(window.overflow) : undefined,
        width,
      ),
      focusedPane(state) === "detail" && !state.prompt,
      managerTone.saved,
    ),
    ...window.visible,
  ];
};

export const renderProfileSetPicker = (
  state: ProfileSetPickerRenderState,
  options: ProfileSetPickerRenderOptions,
): string[] => {
  const { theme } = options;
  return renderTwoPaneFrame({
    theme,
    width: options.width,
    height: options.height,
    frameHeight: options.frameHeight,
    shell: state.shell,
    hasSelection: state.selected !== undefined,
    focusedPane: () => focusedPane(state),
    prompt: state.prompt,
    page: state.menu,
    footer: (inner) => footer(state, inner, options.keybindingLabel),
    // The geometry takes the frame's width, borders included.
    columns: (inner) => wideListDetailGeometry(inner + 2, 30, 0.35),
    stackedListHeight: (bodyHeight, text) =>
      Math.min(
        bodyHeight - 3,
        stackedListHeight(bodyHeight, libraryLines(state, theme, text).length + 1),
      ),
    // A decision about the selected set shows its preview pane.
    singleShowsDetail: state.prompt !== undefined && state.selected !== undefined,
    list: (text, height) => libraryRows(state, theme, text, height),
    detail: (text, height) => previewRows(state, theme, text, height),
  });
};
