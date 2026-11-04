import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { managerLayoutTier, managerNoticeColor, clipToWidth } from "pi-cosmic-ui/manager";
import { managerTable } from "pi-cosmic-ui/manager/table";
import {
  configuredKeyLabels,
  exitKeyHint,
  framedKeyHints,
  keyHint,
  keyHintRows,
  moveKeyHint,
  type FramedKeyHints,
} from "pi-cosmic-ui/manager/key-labels";
import { listWindowStart, wideListDetailGeometry } from "pi-cosmic-ui/manager/list-detail";
import {
  framedBodyWithHints,
  framedFill,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  listDetailHeading,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, LIST_CURSOR, managerTone } from "pi-cosmic-ui/manager/style";
import { profileRouteOptionLabel, SCOPE_LABELS } from "../profile-route-editor.ts";
import {
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
} from "./profile-set-picker-model.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

interface ProfileSetPickerRenderState {
  readonly entries: ReadonlyArray<ProfileSetPickerEntry>;
  readonly selectedIndex: number;
  readonly query: string;
  readonly searching: boolean;
  readonly message?: { readonly kind: "info" | "warning" | "error"; readonly text: string };
}

export const PROFILE_SET_SHORTCUTS: ReadonlySet<string> = new Set(["/", "a", "u"]);

/**
 * Pairs that don't fit the bottom border wrap into rows above it, so Move, Edit, and the exit
 * stay visible at every width.
 */
const footer = (
  state: ProfileSetPickerRenderState,
  inner: number,
  keybindingLabel: SearchableSelectHostOptions["keybindingLabel"],
): FramedKeyHints => {
  const { key } = configuredKeyLabels(keybindingLabel, PROFILE_SET_SHORTCUTS);
  const confirm = key("tui.select.confirm", "Enter");
  const up = key("tui.select.up", "↑");
  const down = key("tui.select.down", "↓");
  const move = moveKeyHint(
    Str.length(up) === 1 && Str.length(down) === 1 ? `${up}${down}` : `${up}/${down}`,
  );
  // Aliases such as C-c belong in expanded help, not the default hint.
  const cancelKeys = key("tui.select.cancel", "Esc");
  const cancel = Str.split(cancelKeys, "/")[0] ?? cancelKeys;
  if (state.searching)
    return framedKeyHints(
      ["Type to filter", move, keyHint(confirm, "Edit")],
      [keyHint(cancel, "Clear")],
      inner,
    );
  return framedKeyHints(
    [
      move,
      keyHint(confirm, "Edit"),
      keyHint("u", "Use"),
      keyHint("a", "Actions"),
      keyHint("/", "Filter"),
      keyHint("Tab", "Current Session"),
    ],
    [exitKeyHint("top", [], cancel)],
    inner,
  );
};

const messageRows = (state: ProfileSetPickerRenderState, theme: Theme): string[] =>
  state.message ? [theme.fg(managerNoticeColor(state.message.kind), state.message.text)] : [];

// Rows align with the pane heading's two-column indent, and wrapped text hangs beneath it.
const PANE_INDENT = "  ";

const indentedWrap = (text: string, width: number): ReadonlyArray<string> =>
  Arr.map(
    wrapTextWithAnsi(text, Math.max(1, width - PANE_INDENT.length)),
    (line) => PANE_INDENT + line,
  );

const libraryRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const header = [
    listDetailHeading(theme, "Saved profile sets", true, managerTone.saved),
    ...(state.searching ? [PANE_INDENT + theme.fg("muted", `Search /${state.query}`)] : []),
    ...Arr.map(messageRows(state, theme), (row) => PANE_INDENT + row),
    ...indentedWrap(
      theme.fg("muted", 'Saved sets stay separate until you choose "Use in Current Session".'),
      width,
    ),
    "",
  ].slice(0, Math.max(0, height - 1));
  const logical: Array<{ readonly text: string; readonly entryIndex?: number }> = [];
  let scope: "project" | "global" | undefined;
  for (let index = 0; index < state.entries.length; index += 1) {
    const entry = state.entries[index];
    if (!entry) continue;
    if (entry.scope !== scope) {
      scope = entry.scope;
      logical.push({ text: PANE_INDENT + theme.fg("muted", SCOPE_LABELS[entry.scope]) });
    }
    const selected = index === state.selectedIndex;
    const invalid =
      entry.kind === "set" && entry.invalid
        ? " · ! fix profiles"
        : entry.kind === "invalid-default"
          ? " · ! clear"
          : "";
    const defaultLabel =
      (entry.kind === "set" || entry.kind === "invalid-default") && entry.scopeDefault
        ? " · default"
        : "";
    logical.push({
      entryIndex: index,
      text: clipToWidth(
        `${selected ? LIST_CURSOR : " "} ${selected && !state.searching ? focusedField(theme, entry.label) : theme.fg(managerTone.saved, entry.label)}${theme.fg("muted", defaultLabel)}${theme.fg("error", invalid)}${selected ? theme.fg("muted", ` · ${entry.description}`) : ""}`,
        width,
      ),
    });
  }
  const listHeight = Math.max(1, height - header.length);
  const selectedRow = Option.getOrElse(
    Arr.findFirstIndex(logical, (row) => row.entryIndex === state.selectedIndex),
    () => 0,
  );
  const start = listWindowStart(logical.length, selectedRow, listHeight);
  return [...header, ...Arr.map(logical.slice(start, start + listHeight), (row) => row.text)];
};

const previewRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const entry = state.entries[state.selectedIndex];
  if (!entry) return [PANE_INDENT + theme.fg("muted", "No saved sets match this search.")];
  if (entry.kind !== "set")
    return indentedWrap(
      theme.fg(entry.kind === "invalid-default" ? "error" : "muted", entry.description),
      width,
    );
  const content = Math.max(1, width - PANE_INDENT.length);
  const rows = [
    listDetailHeading(theme, qualifiedProfileSetLabel(entry.ref), false, managerTone.saved),
  ];
  const budget = Math.max(1, Math.floor((height - 1) / entry.preview.length));
  const profiles = Arr.map(entry.preview, (profile) => ({
    label: `${theme.fg(managerTone.identity, profile.id)}${profile.inherited ? theme.fg("muted", ` · inherited ${Fn.pipe(profile.source, Str.replace("-invalid", ""))}`) : ""}`,
    cells:
      profile.status === "configured"
        ? Arr.map(profile.candidates, (candidate, index) => [
            theme.fg("muted", profileRouteOptionLabel(index)),
            `${theme.fg(managerTone.value, candidate.model)}${candidate.openaiFastMode ? theme.fg("warning", " ⚡") : ""}`,
            theme.fg(
              "muted",
              candidate.effort === "default" ? "profile default" : candidate.effort,
            ),
          ])
        : [[theme.fg(profile.status === "invalid" ? "error" : "muted", profile.status), "", ""]],
  }));
  const table = managerTable(
    Arr.flatMap(profiles, (profile) =>
      Arr.map(profile.cells, (cells) => [profile.label, ...cells]),
    ),
    [
      { minWidth: 10, priority: 5 },
      { minWidth: 7, priority: 2 },
      { minWidth: 16, priority: 4 },
      { minWidth: 7, priority: 3 },
    ],
    content,
  );
  const aligned =
    Arr.every(table.widths, (size) => size > 0) &&
    Arr.every(profiles, (profile) =>
      Arr.every(profile.cells, (cells) => visibleWidth(cells[1] ?? "") <= (table.widths[2] ?? 0)),
    );
  for (const profile of profiles) {
    const lines = Arr.flatMap(profile.cells, (cells, index) => {
      const label = index === 0 ? profile.label : "";
      if (!aligned) {
        const detail = Fn.pipe(cells, Arr.filter(Boolean), Arr.join(" · "));
        return wrapTextWithAnsi(`${label ? `${label}: ` : "  "}${detail}`, content);
      }
      return [table.row([label, ...cells])];
    });
    const visible = lines.slice(0, budget);
    if (lines.length > budget) {
      visible[budget - 1] =
        clipToWidth(visible[budget - 1] ?? "", Math.max(0, content - 1), "") + "…";
    }
    rows.push(...Arr.map(visible, (line) => PANE_INDENT + line));
  }
  if (rows.length < height)
    rows.push(
      PANE_INDENT + theme.fg("dim", "Enter edits the full routes. Current Session is unchanged."),
    );
  return rows;
};

export const renderProfileSetPicker = (
  state: ProfileSetPickerRenderState,
  options: Pick<SearchableSelectHostOptions, "keybindingLabel"> & {
    readonly theme: Theme;
    readonly width: number;
    readonly height: number;
  },
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => Fn.pipe(" ", Str.repeat(width)));
  const theme = options.theme;
  const frame = listDetailFrame(theme, "list");
  const inner = width - 2;
  const title = clipToWidth(" /subagents profiles › Profile sets ", inner, "");
  const hints = footer(state, inner, options.keybindingLabel);
  const hintRows = keyHintRows(hints.overflow, inner, (row) => theme.fg("dim", row));
  return framedScreen(frame, {
    width,
    height,
    top: theme.fg(managerTone.saved, title),
    bottom: hints.border,
    body: (fullHeight) =>
      framedBodyWithHints(frame, { height: fullHeight, inner, hints: hintRows }, (bodyHeight) =>
        pickerBody(state, theme, {
          width,
          inner,
          bodyHeight,
          frame,
          // A body too short for hint rows beside it lists them in its compact summary.
          hints: bodyHeight === fullHeight ? hintRows : [],
        }),
      ),
  });
};

const pickerBody = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  layout: {
    readonly width: number;
    readonly inner: number;
    readonly bodyHeight: number;
    readonly frame: ReturnType<typeof listDetailFrame>;
    readonly hints: ReadonlyArray<string>;
  },
): ReadonlyArray<string> => {
  const { width, inner, bodyHeight, frame, hints } = layout;
  if (bodyHeight <= 4) {
    const entry = state.entries[state.selectedIndex];
    const selected = entry
      ? theme.fg(
          entry.kind === "invalid-default" || (entry.kind === "set" && entry.invalid)
            ? "error"
            : managerTone.saved,
          theme.bold(
            `${LIST_CURSOR} ${entry.kind === "set" ? qualifiedProfileSetLabel(entry.ref) : entry.label}`,
          ),
        )
      : "No saved sets";
    const compact = [selected, ...messageRows(state, theme), ...hints];
    return framedFill(frame, compact.slice(0, bodyHeight), bodyHeight, inner, "list");
  }
  if (managerLayoutTier(width) === "wide") {
    const { listWidth, detailWidth } = wideListDetailGeometry(width, 30, 0.35);
    return framedWideRows(frame, {
      left: libraryRows(state, theme, listWidth, bodyHeight),
      right: previewRows(state, theme, detailWidth, bodyHeight),
      height: bodyHeight,
      listWidth,
      detailWidth,
    });
  }
  if (managerLayoutTier(width) === "stacked" && bodyHeight >= 6) {
    const listHeight = Math.max(4, Math.min(8, Math.floor(bodyHeight / 3)));
    return framedStackedRows(frame, {
      list: libraryRows(state, theme, inner, listHeight),
      detail: previewRows(state, theme, inner, bodyHeight - listHeight - 1),
      height: bodyHeight,
      inner,
    });
  }
  const rows = libraryRows(state, theme, inner, bodyHeight);
  return framedFill(frame, rows.slice(0, bodyHeight), bodyHeight, inner, "list");
};
