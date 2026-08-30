import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { framedFill, framedScreen, listDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import type { ProfileSetPickerEntry } from "./profile-set-picker-model.ts";

export interface ProfileSetPickerRenderState {
  readonly entries: ReadonlyArray<ProfileSetPickerEntry>;
  readonly selectedIndex: number;
  readonly query: string;
  readonly searching: boolean;
  readonly projectTrusted?: boolean | undefined;
  readonly message?: { readonly kind: "info" | "warning" | "error"; readonly text: string };
  readonly actionMenu?:
    | {
        readonly label: string;
        readonly choices: ReadonlyArray<{
          readonly label: string;
          readonly description: string;
          readonly enabled: boolean;
        }>;
        readonly selectedIndex: number;
      }
    | undefined;
  readonly pendingDeleteLabel?: string | undefined;
}

const windowStart = (length: number, selected: number, visible: number): number =>
  Math.max(0, Math.min(Math.max(0, length - visible), selected - Math.floor(visible / 2)));

const footer = (state: ProfileSetPickerRenderState, width: number): string => {
  if (state.pendingDeleteLabel)
    return renderResponsiveManagerFooter(width, [["Enter Confirm · Esc Cancel"]]);
  if (state.actionMenu) return renderResponsiveManagerFooter(width, [["Enter Choose · Esc Back"]]);
  if (state.searching)
    return renderResponsiveManagerFooter(width, [["Type to filter · Enter Actions · Esc Clear"]]);
  return renderResponsiveManagerFooter(width, [
    ["Enter Actions", "s Save Current Session", "Esc Back"],
    ["Enter", "s Save Current Session", "Esc"],
  ]);
};

const menuRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const menu = state.actionMenu;
  if (!menu) return [];
  const limit = Math.max(1, height - 5);
  const start = windowStart(menu.choices.length, menu.selectedIndex, limit);
  const selected = menu.choices[menu.selectedIndex];
  return [
    theme.fg("accent", theme.bold(menu.label)),
    theme.fg("muted", "Choose an action"),
    "",
    ...menu.choices.slice(start, start + limit).map((choice, offset) => {
      const index = start + offset;
      return `${index === menu.selectedIndex ? ">" : " "} ${choice.label}${choice.enabled ? "" : " · unavailable"}`;
    }),
    ...(selected && height >= 6 ? ["", theme.fg("muted", selected.description)] : []),
  ];
};

const libraryRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const header = [
    theme.fg("accent", theme.bold("Saved profile sets")),
    theme.fg("muted", 'Saved sets stay separate until you choose "Use in Current Session".'),
    theme.fg("accent", "s  Save Current Session as a new set"),
    ...(state.searching ? [theme.fg("muted", `Search /${state.query}`)] : []),
    ...(state.message
      ? [
          theme.fg(
            state.message.kind === "error"
              ? "error"
              : state.message.kind === "warning"
                ? "warning"
                : "muted",
            state.message.text,
          ),
        ]
      : []),
    "",
  ];
  const logical: Array<{ readonly text: string; readonly entryIndex?: number }> = [];
  let scope: "project" | "global" | undefined;
  for (let index = 0; index < state.entries.length; index += 1) {
    const entry = state.entries[index];
    if (!entry) continue;
    if (entry.scope !== scope) {
      scope = entry.scope;
      logical.push({ text: theme.fg("accent", entry.scope === "project" ? "Project" : "Global") });
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
      text: `${selected ? ">" : " "} ${entry.label}${defaultLabel}${invalid}${selected ? ` · ${entry.description}` : ""}`,
    });
  }
  const listHeight = Math.max(1, height - header.length);
  const selectedRow = Math.max(
    0,
    logical.findIndex((row) => row.entryIndex === state.selectedIndex),
  );
  const start = windowStart(logical.length, selectedRow, listHeight);
  return [...header, ...logical.slice(start, start + listHeight).map((row) => row.text)];
};

export const renderProfileSetPicker = (
  state: ProfileSetPickerRenderState,
  options: { readonly theme: Theme; readonly width: number; readonly height: number },
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => " ".repeat(width));
  const theme = options.theme;
  const frame = listDetailFrame(theme);
  const inner = width - 2;
  const title = truncateToWidth(" /subagents profiles › Profile sets ", inner, "");
  const bottom = truncateToWidth(footer(state, inner), inner, "");
  return framedScreen(frame, {
    width,
    height,
    top: title,
    bottom,
    body: (bodyHeight) => {
      const rows = state.pendingDeleteLabel
        ? [
            theme.fg("warning", theme.bold(`Delete ${state.pendingDeleteLabel}?`)),
            theme.fg("warning", "This deletes the saved set. Current Session will not change."),
            theme.fg("warning", "Enter confirms · Esc cancels"),
          ]
        : state.actionMenu
          ? menuRows(state, theme, bodyHeight)
          : libraryRows(state, theme, bodyHeight);
      if (bodyHeight <= 4) {
        const selectedAction = state.actionMenu?.choices[state.actionMenu.selectedIndex];
        const compactMenu =
          state.actionMenu && selectedAction
            ? bodyHeight === 1
              ? [`> ${selectedAction.label}${selectedAction.enabled ? "" : " · unavailable"}`]
              : [
                  theme.fg("accent", theme.bold(state.actionMenu.label)),
                  `> ${selectedAction.label}${selectedAction.enabled ? "" : " · unavailable"}`,
                  theme.fg("muted", selectedAction.description),
                ]
            : rows;
        const safety = state.pendingDeleteLabel
          ? rows
          : state.actionMenu
            ? compactMenu
            : [
                ...(state.projectTrusted === false
                  ? [theme.fg("warning", "Trust this project to view its saved profile sets")]
                  : []),
                rows.find((row) => visibleWidth(row) > 0) ?? "Saved profile sets",
                theme.fg("dim", "Enter Actions · s Save Current Session · Esc Back"),
              ];
        return framedFill(frame, safety.slice(0, bodyHeight), bodyHeight, inner);
      }
      return framedFill(frame, rows.slice(0, bodyHeight), bodyHeight, inner);
    },
  });
};
